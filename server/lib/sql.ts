// SQL generation helpers. We only ever build read-only SELECTs, and every
// identifier (table + columns) is validated to be an exact member of the live
// Unity Catalog metadata before use — never taken from free text. Identifiers
// are backtick-quoted with backtick-doubling so real-world names with spaces or
// punctuation (e.g. `Country/Region`, `Row ID`) round-trip safely.

/** Backtick-quote one identifier, escaping embedded backticks by doubling. */
export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Quote a three-level UC name (catalog.schema.table). */
export function quoteFullName(fullName: string): string {
  const parts = fullName.split('.');
  if (parts.length !== 3) {
    throw new Error(`Expected catalog.schema.table, got: ${fullName}`);
  }
  return parts.map(quoteIdent).join('.');
}

/** Ensure every requested column is present in the live column list. */
function assertAllowed(columns: string[], allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const c of columns) {
    if (!allowedSet.has(c)) {
      throw new Error(`Column not found in table: ${c}`);
    }
  }
}

/**
 * Build the report's detail query: the selected columns from the source table,
 * ordered by the group-by columns (so the server can detect group breaks by
 * scanning rows in order). All identifiers must be a subset of `allowed`.
 */
export function buildReportQuery(
  fullName: string,
  columns: string[],
  groupBy: string[],
  allowed: string[],
  limit: number,
): string {
  if (columns.length === 0) {
    throw new Error('At least one column is required');
  }
  assertAllowed(columns, allowed);
  assertAllowed(groupBy, allowed);

  const cols = columns.map(quoteIdent).join(', ');
  let sql = `SELECT ${cols} FROM ${quoteFullName(fullName)}`;
  if (groupBy.length > 0) {
    sql += ` ORDER BY ${groupBy.map(quoteIdent).join(', ')}`;
  }
  sql += ` LIMIT ${clampLimit(limit, limit, 100000)}`;
  return sql;
}

/** A selected column's aggregation, with its index into the report's column list. */
export interface AggColumn {
  index: number;
  name: string;
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'none';
}

/** Map an aggregation to a Spark SQL aggregate expression over a quoted column. */
function aggExpr(agg: AggColumn['agg'], quotedCol: string): string | null {
  switch (agg) {
    case 'sum':
      return `SUM(${quotedCol})`;
    case 'avg':
      return `AVG(${quotedCol})`;
    case 'min':
      return `MIN(${quotedCol})`;
    case 'max':
      return `MAX(${quotedCol})`;
    case 'count':
      return `COUNT(${quotedCol})`;
    default:
      return null;
  }
}

/**
 * Build the aggregate query. Uses `GROUP BY ROLLUP(group cols)` so a single
 * warehouse pass returns, for the WHOLE table:
 *   - one row per group value combination (the per-group subtotals), and
 *   - one all-NULL row (the grand total).
 * `GROUPING(col)` flags tell us which level each row belongs to. Because the
 * warehouse does the aggregation, this scales to very large tables — the result
 * is only as big as the number of groups, never the number of detail rows.
 *
 * Aliases are stable so the caller can read them back:
 *   grp_<i>   group column i's value
 *   gflag_<i> 1 if column i is rolled up (NULL) in this row, else 0
 *   agg_cnt   COUNT(*) for the group
 *   agg_<j>   the aggregate for report column j (only for aggregated columns)
 */
export function buildAggregateQuery(
  fullName: string,
  columns: AggColumn[],
  groupBy: string[],
  allowed: string[],
): string {
  assertAllowed(
    columns.map((c) => c.name),
    allowed,
  );
  assertAllowed(groupBy, allowed);

  const selects: string[] = [];
  groupBy.forEach((g, i) => {
    selects.push(`${quoteIdent(g)} AS grp_${i}`);
    selects.push(`GROUPING(${quoteIdent(g)}) AS gflag_${i}`);
  });
  selects.push(`COUNT(*) AS agg_cnt`);
  for (const c of columns) {
    const expr = aggExpr(c.agg, quoteIdent(c.name));
    if (expr) selects.push(`${expr} AS agg_${c.index}`);
  }

  let sql = `SELECT ${selects.join(', ')} FROM ${quoteFullName(fullName)}`;
  if (groupBy.length > 0) {
    sql += ` GROUP BY ROLLUP(${groupBy.map(quoteIdent).join(', ')})`;
  }
  return sql;
}

/** Clamp a requested row limit into a safe range. */
export function clampLimit(raw: unknown, def = 50, max = 1000): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
