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
 * A single equality filter used for "report bursting" — rendering the report
 * for one group value (e.g. hospital = 'Kaiser'). The value is a raw cell value
 * (usually a string discovered from the data); we turn it into a safe SQL
 * literal, never string-concatenating user text into the query unescaped.
 */
export interface ReportFilter {
  column: string;
  /** null means the group value is SQL NULL (rendered as `IS NULL`). */
  value: string | number | boolean | null;
  type: 'string' | 'number' | 'boolean' | 'date';
}

/** Render a value as a safe SQL literal for the given scalar type. */
export function sqlLiteral(value: ReportFilter['value'], type: ReportFilter['type']): string {
  if (value === null) return 'NULL';
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Invalid numeric filter value: ${String(value)}`);
    return String(n);
  }
  if (type === 'boolean') {
    return value === true || value === 'true' ? 'TRUE' : 'FALSE';
  }
  // string / date → single-quoted, with single quotes and backslashes escaped.
  // Spark SQL treats backslash as an escape char in string literals by default.
  const s = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${s}'`;
}

/** Build a `WHERE` clause for an optional burst filter (empty string if none). */
function whereClause(filter: ReportFilter | undefined, allowed: string[]): string {
  if (!filter) return '';
  assertAllowed([filter.column], allowed);
  const col = quoteIdent(filter.column);
  if (filter.value === null) return ` WHERE ${col} IS NULL`;
  return ` WHERE ${col} = ${sqlLiteral(filter.value, filter.type)}`;
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
  filter?: ReportFilter,
): string {
  if (columns.length === 0) {
    throw new Error('At least one column is required');
  }
  assertAllowed(columns, allowed);
  assertAllowed(groupBy, allowed);

  const cols = columns.map(quoteIdent).join(', ');
  let sql = `SELECT ${cols} FROM ${quoteFullName(fullName)}`;
  sql += whereClause(filter, allowed);
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
  filter?: ReportFilter,
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
  sql += whereClause(filter, allowed);
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
