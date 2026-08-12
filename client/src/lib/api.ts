// Tiny fetch wrapper for the app's JSON API + shared client types.

export type ColumnType = 'string' | 'number' | 'boolean' | 'date';
export type Aggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'none';
export type PageSize = 'A4' | 'Letter';
export type Orientation = 'portrait' | 'landscape';

export interface ReportColumn {
  name: string;
  label: string;
  type: ColumnType;
  agg: Aggregation;
}

export interface Report {
  id: string;
  name: string;
  user_email: string;
  source_table: string | null;
  columns: ReportColumn[];
  group_by: string[];
  page_size: PageSize;
  orientation: Orientation;
  created_at: string;
  updated_at: string;
}

/** Summary row of the reports list. */
export interface ReportSummary {
  id: string;
  name: string;
  source_table: string | null;
  group_by: string[];
  updated_at: string;
}

export interface StructureField {
  name: string;
  type: string;
  children?: StructureField[];
}

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'cron';
export type DeliveryMode = 'single' | 'split';

export interface RecipientMapEntry {
  value: string | null;
  recipients: string[];
}

export interface Schedule {
  id: string;
  report_id: string;
  created_by: string;
  recipients: string[];
  subject: string;
  body: string;
  cron: string;
  timezone: string;
  summary: string;
  enabled: boolean;
  mode: DeliveryMode;
  split_column: string | null;
  recipient_map: RecipientMapEntry[];
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulesResponse {
  mailerConfigured: boolean;
  schedules: Schedule[];
}

export interface GroupValuesResponse {
  column: string;
  values: { value: string | null; type: string }[];
}

export interface UcColumn {
  name: string;
  type_text: string;
  comment?: string;
  field: StructureField;
}

// ---- Preview (banded view) types, mirrors server/lib/report-model.ts ----

export type ReportLine =
  | { type: 'group-header'; level: number; label: string; column: string; value: string }
  | { type: 'detail'; cells: string[] }
  | { type: 'group-summary'; level: number; label: string; cells: (string | null)[]; count: number }
  | { type: 'grand-total'; label: string; cells: (string | null)[]; count: number };

export interface ReportView {
  columns: ReportColumn[];
  groupBy: string[];
  lines: ReportLine[];
  /** Exact full-table row count (from the SQL grand total). */
  rowCount: number;
  /** How many detail rows were actually rendered in this view. */
  detailShown: number;
  /** True if the detail cap was hit (subtotals are still exact). */
  detailTruncated: boolean;
  /** True when the requested grouping was too high-cardinality and dropped. */
  groupingTooLarge: boolean;
  /** The grouping the user asked for (present even when dropped). */
  requestedGroupBy: string[];
  sql_limit: number;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const api = {
  get: <T>(url: string) => fetch(url).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => handle<T>(r)),
  patch: <T>(url: string, body: unknown) =>
    fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  del: (url: string) => fetch(url, { method: 'DELETE' }).then((r) => handle<void>(r)),
};
