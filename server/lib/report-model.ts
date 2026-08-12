// The banding engine — assembles a banded report from two inputs:
//
//   1. detailRows : the selected columns, ORDER BY the group-by columns, but
//                   BOUNDED (a row cap) so a huge table can't blow up memory.
//   2. aggRows    : the result of a `GROUP BY ROLLUP(group cols)` run on the
//                   warehouse over the WHOLE table — so per-group subtotals and
//                   the grand total are EXACT for the full dataset, no matter
//                   how many detail rows were fetched.
//
// The output is an ordered list of "lines":
//
//   group-header      ── one per group value, e.g. "Hospital: Geisinger CMC"
//     detail…         ── the raw rows for that group (may be partial/absent if
//                        the detail cap was hit for large tables)
//   group-summary     ── EXACT full-table aggregates for that group
//   … (nested groups repeat the pattern, innermost first) …
//   grand-total       ── EXACT full-table aggregates across every row
//
// Because the structure and all summaries come from the (small) ROLLUP result,
// this scales to very large tables: the number of lines is driven by the number
// of groups, not the number of rows.

import type { Aggregation, ReportColumn } from './types.js';

export type Row = Record<string, unknown>;

/** A single line of the rendered report. `cells` always aligns to `columns`. */
export type ReportLine =
  | { type: 'group-header'; level: number; label: string; column: string; value: string }
  | { type: 'detail'; cells: string[] }
  | { type: 'group-summary'; level: number; label: string; cells: (string | null)[]; count: number }
  | { type: 'grand-total'; label: string; cells: (string | null)[]; count: number };

export interface ReportView {
  columns: ReportColumn[];
  groupBy: string[];
  lines: ReportLine[];
  /** Exact full-table row count (from the ROLLUP grand-total COUNT(*)). */
  rowCount: number;
  /** How many detail rows were actually fetched/rendered. */
  detailShown: number;
  /** True if the detail row cap was hit (some groups may show partial detail). */
  detailTruncated: boolean;
  /** True when the requested grouping was too high-cardinality and dropped. */
  groupingTooLarge: boolean;
  /** The grouping the user asked for (present even when dropped). */
  requestedGroupBy: string[];
}

/** Guardrail: refuse to build more than this many group rows (high-cardinality grouping). */
const MAX_GROUPS = 100000;

/** Coerce a raw cell to a finite number, or null if not numeric. */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Format a raw detail cell value for display. */
export function formatValue(v: unknown, type: ReportColumn['type']): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (type === 'number') {
    const n = toNumber(v);
    if (n !== null) return formatNumber(n);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** Format a number with thousands separators; up to 2 decimals when needed. */
export function formatNumber(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Short human label for an aggregation (used in summary row prefixes). */
export function aggLabel(agg: Aggregation): string {
  switch (agg) {
    case 'sum':
      return 'Sum';
    case 'avg':
      return 'Avg';
    case 'min':
      return 'Min';
    case 'max':
      return 'Max';
    case 'count':
      return 'Count';
    default:
      return '';
  }
}

/** Safe string form of an arbitrary cell value (objects are JSON-encoded). */
function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** Stable key for a group value path (handles nulls + type coercion). */
function pathKey(values: unknown[]): string {
  return values.map((v) => (v === null || v === undefined ? '' : ` ${asString(v)}`)).join('');
}

/** Order comparator: numeric when both parse as numbers, else string; nulls last. */
function cmpValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return asString(a).localeCompare(asString(b));
}

/** One parsed ROLLUP row: the aggregate for a specific group path. */
interface AggEntry {
  /** Present group values (length = the grouping level, 0 = grand total). */
  path: unknown[];
  count: number;
  /** Aggregate value per report column index, or null if that column isn't aggregated. */
  cells: (number | null)[];
}

/**
 * Parse the raw ROLLUP result rows into AggEntry objects. Each row carries
 * grp_i / gflag_i for the group columns and agg_<index> for aggregated columns.
 * The grouping "level" is the number of leading present (gflag=0) columns.
 */
function parseAggRows(aggRows: Row[], columns: ReportColumn[], groupBy: string[]): AggEntry[] {
  return aggRows.map((r) => {
    // Level = index of the first rolled-up (gflag=1) column, else all present.
    let level = groupBy.length;
    for (let i = 0; i < groupBy.length; i++) {
      if (toNumber(r[`gflag_${i}`]) === 1) {
        level = i;
        break;
      }
    }
    const path = groupBy.slice(0, level).map((_, i) => r[`grp_${i}`]);
    const cells = columns.map((c, idx) => (c.agg === 'none' ? null : toNumber(r[`agg_${idx}`])));
    return { path, count: toNumber(r['agg_cnt']) ?? 0, cells };
  });
}

/** Render an AggEntry's numeric cells to display strings (null stays null). */
function renderCells(cells: (number | null)[]): (string | null)[] {
  return cells.map((v) => (v === null ? null : formatNumber(v)));
}

/**
 * Build the full banded report view.
 *
 * @param detailRows bounded detail rows, ORDER BY the group columns
 * @param aggRows    ROLLUP result over the whole table
 * @param groupBy    the grouping actually applied (may be [] after fallback)
 * @param detailTruncated whether the detail cap was hit
 * @param opts       high-cardinality fallback metadata
 */
export function buildReportView(
  detailRows: Row[],
  aggRows: Row[],
  columns: ReportColumn[],
  groupBy: string[],
  detailTruncated = false,
  opts: { groupingTooLarge?: boolean; requestedGroupBy?: string[] } = {},
): ReportView {
  const entries = parseAggRows(aggRows, columns, groupBy);

  // Index every aggregate row by its present path (unique thanks to ROLLUP's
  // prefix structure), and collect the leaf paths (all group cols present).
  const byPath = new Map<string, AggEntry>();
  const leafPaths: unknown[][] = [];
  let grand: AggEntry | undefined;
  for (const e of entries) {
    byPath.set(pathKey(e.path), e);
    if (e.path.length === 0) grand = e;
    if (e.path.length === groupBy.length && groupBy.length > 0) leafPaths.push(e.path);
  }
  if (leafPaths.length > MAX_GROUPS) {
    throw new Error(
      `This grouping produces ${leafPaths.length.toLocaleString()} groups (limit ${MAX_GROUPS.toLocaleString()}). ` +
        `Group by a lower-cardinality column.`,
    );
  }

  // Bucket the bounded detail rows by their full group path.
  const detailByPath = new Map<string, Row[]>();
  for (const r of detailRows) {
    const key = pathKey(groupBy.map((g) => r[g]));
    const bucket = detailByPath.get(key);
    if (bucket) bucket.push(r);
    else detailByPath.set(key, [r]);
  }

  const colType = (name: string) => columns.find((c) => c.name === name)?.type ?? 'string';
  const colLabel = (name: string) => columns.find((c) => c.name === name)?.label ?? name;

  const lines: ReportLine[] = [];

  // Recursively emit headers + detail + summaries, driven by the aggregate leaf
  // paths (so every group appears with its exact subtotal).
  const emit = (level: number, prefix: unknown[]): void => {
    if (level >= groupBy.length) {
      // Leaf: attach whatever bounded detail we have for this exact path.
      const rows = detailByPath.get(pathKey(prefix)) ?? [];
      for (const row of rows) {
        lines.push({ type: 'detail', cells: columns.map((c) => formatValue(row[c.name], c.type)) });
      }
      return;
    }

    // Distinct next-level values under this prefix, in sorted order.
    const prefixKey = pathKey(prefix);
    const seen = new Map<string, unknown>();
    for (const lp of leafPaths) {
      if (pathKey(lp.slice(0, level)) !== prefixKey) continue;
      const v = lp[level];
      const k = pathKey([v]);
      if (!seen.has(k)) seen.set(k, v);
    }
    const values = [...seen.values()].sort(cmpValues);

    const groupCol = groupBy[level];
    const label = colLabel(groupCol);
    for (const value of values) {
      const path = [...prefix, value];
      const valueText = formatValue(value, colType(groupCol)) || '(blank)';
      lines.push({ type: 'group-header', level, label, column: groupCol, value: valueText });

      emit(level + 1, path);

      const summary = byPath.get(pathKey(path));
      lines.push({
        type: 'group-summary',
        level,
        label: `${label}: ${valueText}`,
        cells: summary ? renderCells(summary.cells) : columns.map(() => null),
        count: summary?.count ?? 0,
      });
    }
  };

  emit(0, []);

  // Grand total (from the all-rolled-up ROLLUP row).
  const grandCells = grand ? renderCells(grand.cells) : columns.map(() => null);
  const rowCount = grand?.count ?? detailRows.length;
  if (grandCells.some((c) => c !== null) || groupBy.length > 0) {
    lines.push({ type: 'grand-total', label: 'Grand total', cells: grandCells, count: rowCount });
  }

  return {
    columns,
    groupBy,
    lines,
    rowCount,
    detailShown: detailRows.length,
    detailTruncated,
    groupingTooLarge: opts.groupingTooLarge ?? false,
    requestedGroupBy: opts.requestedGroupBy ?? groupBy,
  };
}
