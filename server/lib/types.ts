// Shared domain types for the grouped paginated-reporting app.
//
// A "report" is a saved configuration over exactly one Unity Catalog table:
//   - an ordered set of selected columns (each with a display label + type),
//   - an ordered set of group-by columns (each produces a break in the output),
//   - a per-column summary aggregation (sum/avg/... applied at each group break
//     and as a grand total; only meaningful for numeric columns).
// The output is a banded report: rows are ordered by the group-by columns, a
// summary band is emitted at the end of each group, and a grand-total band at
// the end. It can be previewed as JSON and downloaded as a real PDF.

/** Parsed scalar type of a column (from UC `type_text`). */
export type ColumnType = 'string' | 'number' | 'boolean' | 'date';

/** Summary aggregation applied to a column at group breaks + grand total. */
export type Aggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'none';

/** A single selected column in a report. */
export interface ReportColumn {
  /** UC column name (validated against live metadata before use in SQL). */
  name: string;
  /** Display label shown in headers (defaults to the column name). */
  label: string;
  /** Parsed scalar type; drives which aggregations are offered. */
  type: ColumnType;
  /** Aggregation for the summary rows. 'none' means no summary for this column. */
  agg: Aggregation;
}

export type PageSize = 'A4' | 'Letter';
export type Orientation = 'portrait' | 'landscape';

/** A saved report configuration. */
export interface Report {
  id: string;
  name: string;
  user_email: string;
  /** Source table, catalog.schema.table. Null until a table is chosen. */
  source_table: string | null;
  /** Ordered selected columns. */
  columns: ReportColumn[];
  /** Ordered group-by column names; each produces a break/summary band. */
  group_by: string[];
  page_size: PageSize;
  orientation: Orientation;
  created_at: string;
  updated_at: string;
}

/** A node in a table's inferred field tree (parsed from UC `type_text`). */
export interface StructureField {
  name: string;
  /** "string" | "number" | "boolean" | "date" | "array" | "object" */
  type: string;
  children?: StructureField[];
}

/** How often a scheduled email fires. Presets compile to a cron string. */
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'cron';

/** A saved email schedule for a report. */
export interface Schedule {
  id: string;
  report_id: string;
  created_by: string;
  recipients: string[];
  subject: string;
  body: string;
  /** Canonical 5-field cron expression (presets are compiled to this). */
  cron: string;
  /** IANA timezone used to interpret the cron (e.g. America/New_York). */
  timezone: string;
  /** Human-readable summary, e.g. "Weekly on Monday at 08:00 (America/New_York)". */
  summary: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SendStatus = 'sent' | 'preview' | 'failed';
export type SendTrigger = 'schedule' | 'manual';

/** One row of the send audit log. */
export interface SendLogEntry {
  id: string;
  schedule_id: string | null;
  report_id: string | null;
  status: SendStatus;
  recipients: string[];
  trigger: SendTrigger;
  pdf_bytes: number | null;
  row_count: number | null;
  error: string | null;
  created_at: string;
}
