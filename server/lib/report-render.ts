// Shared report-rendering pipeline, independent of any HTTP request.
//
// Both the interactive routes and the background scheduler use these helpers.
// The only difference is WHO the Unity Catalog metadata lookup runs as: routes
// pass an on-behalf-of-user workspace client, the scheduler passes the app
// service-principal client. The warehouse query itself always runs as the SP
// (AppKit's OBO analytics path is broken — see lib/appkit.ts).

import type { WorkspaceClient as LegacyWorkspaceClient } from '@databricks/sdk-experimental';
import type { AppKit } from './appkit.js';
import type { ColumnType, Report } from './types.js';
import { columnTypeFromText } from './type-parser.js';
import {
  buildReportQuery,
  buildAggregateQuery,
  quoteIdent,
  quoteFullName,
  clampLimit,
  type AggColumn,
  type ReportFilter,
} from './sql.js';
import { buildReportView, type ReportView } from './report-model.js';
import { generatePdf } from './pdf.js';

/** Detail-row cap for the PDF. Subtotals/grand total are computed by the
 *  warehouse over the FULL table regardless; this only bounds rendered detail. */
export const PDF_DETAIL_CAP = 50000;

export interface LiveColumn {
  name: string;
  type: ColumnType;
  type_text: string;
}

/** Read a table's live column metadata via the given workspace client. */
export async function liveColumns(
  ws: LegacyWorkspaceClient,
  fullName: string,
): Promise<LiveColumn[]> {
  const table = await ws.tables.get({ full_name: fullName });
  return (table.columns ?? []).map((c) => {
    const typeText = c.type_text ?? c.type_name ?? 'string';
    return { name: c.name ?? '', type: columnTypeFromText(typeText), type_text: typeText };
  });
}

export interface ReportData {
  detailRows: Record<string, unknown>[];
  aggRows: Record<string, unknown>[];
  detailTruncated: boolean;
}

/**
 * Run the two report queries: a BOUNDED detail SELECT and a full-table ROLLUP
 * aggregate. The aggregate is computed in the warehouse, so subtotals scale to
 * very large tables regardless of the detail cap.
 */
export async function fetchReportData(
  appkit: AppKit,
  report: Report,
  live: LiveColumn[],
  detailLimit: number,
  filter?: ReportFilter,
): Promise<ReportData> {
  if (!report.source_table) throw new Error('Report has no source table');
  if (report.columns.length === 0) throw new Error('Report has no columns selected');
  const allowed = live.map((c) => c.name);

  const detailSql = buildReportQuery(
    report.source_table,
    report.columns.map((c) => c.name),
    report.group_by,
    allowed,
    detailLimit + 1, // one extra row to detect truncation
    filter,
  );

  const aggColumns: AggColumn[] = report.columns.map((c, index) => ({
    index,
    name: c.name,
    agg: c.agg,
  }));
  const aggSql = buildAggregateQuery(
    report.source_table,
    aggColumns,
    report.group_by,
    allowed,
    filter,
  );

  const [detailResult, aggResult] = await Promise.all([
    appkit.analytics.query(detailSql),
    appkit.analytics.query(aggSql),
  ]);

  const allDetail = detailResult.data ?? [];
  const detailTruncated = allDetail.length > detailLimit;
  const detailRows = detailTruncated ? allDetail.slice(0, detailLimit) : allDetail;

  return { detailRows, aggRows: aggResult.data ?? [], detailTruncated };
}

/** Build the banded view for a report (used by the preview endpoint). */
export async function buildView(
  appkit: AppKit,
  ws: LegacyWorkspaceClient,
  report: Report,
  detailLimit: number,
  filter?: ReportFilter,
): Promise<ReportView> {
  const live = await liveColumns(ws, report.source_table ?? '');
  const { detailRows, aggRows, detailTruncated } = await fetchReportData(
    appkit,
    report,
    live,
    detailLimit,
    filter,
  );
  return buildReportView(detailRows, aggRows, report.columns, report.group_by, detailTruncated);
}

/**
 * Render a report to a PDF buffer, returning the byte buffer + row count.
 * When `filter` is supplied (report bursting), the PDF contains only the rows
 * matching that group value, with its own subtotals + grand total.
 */
export async function renderReportPdf(
  appkit: AppKit,
  ws: LegacyWorkspaceClient,
  report: Report,
  filter?: ReportFilter,
): Promise<{ pdf: Buffer; rowCount: number }> {
  const view = await buildView(appkit, ws, report, PDF_DETAIL_CAP, filter);
  const pdf = await generatePdf(report, view);
  return { pdf, rowCount: view.rowCount };
}

/**
 * Distinct values of a group column (for the burst mapping UI). Runs as
 * whoever owns `ws`. Values come back as raw cells; the caller pairs them with
 * recipient lists. Capped so a high-cardinality column can't return unbounded.
 */
export async function distinctValues(
  appkit: AppKit,
  report: Report,
  column: string,
  live: LiveColumn[],
  limit = 500,
): Promise<{ value: string | null; type: ColumnType }[]> {
  if (!report.source_table) throw new Error('Report has no source table');
  const allowed = new Set(live.map((c) => c.name));
  if (!allowed.has(column)) throw new Error(`Column not found in table: ${column}`);
  const col = live.find((c) => c.name === column);
  const type = col?.type ?? 'string';

  const sql =
    `SELECT ${quoteIdent(column)} AS v FROM ${quoteFullName(report.source_table)} ` +
    `GROUP BY ${quoteIdent(column)} ORDER BY ${quoteIdent(column)} LIMIT ${clampLimit(limit, limit, 2000)}`;
  const result = await appkit.analytics.query(sql);
  return (result.data ?? []).map((r) => {
    const v = r['v'];
    if (v === null || v === undefined) return { value: null, type };
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean);
    return { value: s, type };
  });
}

/** Filesystem-safe filename stem for a report. */
export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'report';
}
