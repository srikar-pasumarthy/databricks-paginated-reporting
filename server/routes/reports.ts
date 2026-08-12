// Report CRUD + preview + PDF rendering.
//
// A report is owned by the user who created it. Editing stores a JSONB config
// (selected columns with labels/types/aggregations, group-by columns, page
// options). Preview/PDF re-validate every identifier against LIVE Unity Catalog
// metadata (on-behalf-of the user, so UC grants apply), build a read-only
// SELECT, run it via the analytics warehouse, then band + aggregate the rows.

import type { Application, Request } from 'express';
import type { AppKit } from '../lib/appkit.js';
import { asyncHandler, param } from '../lib/http.js';
import { currentEmail, HttpError, requireOwner } from '../lib/access.js';
import { ucClient } from '../lib/clients.js';
import { clampLimit } from '../lib/sql.js';
import {
  buildView,
  liveColumns as liveColumnsWs,
  renderReportPdf,
  safeFileName,
  type LiveColumn,
} from '../lib/report-render.js';
import type { Aggregation, Orientation, PageSize, Report, ReportColumn } from '../lib/types.js';

const AGGS: Aggregation[] = ['sum', 'avg', 'min', 'max', 'count', 'none'];
const PAGE_SIZES: PageSize[] = ['A4', 'Letter'];
const ORIENTATIONS: Orientation[] = ['portrait', 'landscape'];

/** Live column metadata for a table, read on-behalf-of the requesting user. */
async function liveColumns(req: Request, fullName: string): Promise<LiveColumn[]> {
  return liveColumnsWs(ucClient(req), fullName);
}

/** Sanitize a client-supplied report config against live table metadata. */
function sanitizeConfig(
  body: Record<string, unknown>,
  live: LiveColumn[],
): { columns: ReportColumn[]; group_by: string[] } {
  const liveByName = new Map(live.map((c) => [c.name, c]));

  const rawCols = Array.isArray(body.columns) ? body.columns : [];
  const columns: ReportColumn[] = [];
  for (const raw of rawCols) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : '';
    const lc = liveByName.get(name);
    if (!lc) continue; // drop columns not present in the live table
    const type = lc.type;
    let agg = typeof r.agg === 'string' && (AGGS as string[]).includes(r.agg) ? (r.agg as Aggregation) : 'none';
    // Only numeric columns may use numeric aggregations; count is allowed for any.
    if (agg !== 'none' && agg !== 'count' && type !== 'number') agg = 'none';
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : name;
    columns.push({ name, label, type, agg });
  }

  const selected = new Set(columns.map((c) => c.name));
  const rawGroups = Array.isArray(body.group_by) ? body.group_by : [];
  const group_by: string[] = [];
  for (const g of rawGroups) {
    // A group-by column must be one of the selected columns.
    if (typeof g === 'string' && selected.has(g) && !group_by.includes(g)) group_by.push(g);
  }

  return { columns, group_by };
}

function coercePageSize(v: unknown, fallback: PageSize): PageSize {
  return typeof v === 'string' && (PAGE_SIZES as string[]).includes(v) ? (v as PageSize) : fallback;
}
function coerceOrientation(v: unknown, fallback: Orientation): Orientation {
  return typeof v === 'string' && (ORIENTATIONS as string[]).includes(v)
    ? (v as Orientation)
    : fallback;
}

export function registerReportRoutes(app: Application, appkit: AppKit): void {
  // List the current user's reports.
  app.get(
    '/api/reports',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const { rows } = await appkit.lakebase.query(
        `SELECT id, name, source_table, group_by, updated_at
           FROM greport.reports WHERE user_email = $1 ORDER BY updated_at DESC`,
        [email],
      );
      res.json(rows);
    }),
  );

  // Create a report.
  app.post(
    '/api/reports',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled report';
      const { rows } = await appkit.lakebase.query<Report>(
        `INSERT INTO greport.reports (name, user_email) VALUES ($1, $2)
         RETURNING id, name, user_email, source_table, columns, group_by, page_size, orientation, created_at, updated_at`,
        [name, email],
      );
      res.status(201).json(rows[0]);
    }),
  );

  // Get one report.
  app.get(
    '/api/reports/:id',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      res.json(report);
    }),
  );

  // Update a report's configuration.
  app.patch(
    '/api/reports/:id',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const existing = await requireOwner(appkit, param(req, 'id'), email);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const name =
        typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
      const page_size = coercePageSize(body.page_size, existing.page_size);
      const orientation = coerceOrientation(body.orientation, existing.orientation);

      // Determine the effective source table (may be changing in this request).
      const source_table =
        typeof body.source_table === 'string' ? body.source_table : existing.source_table;

      let columns = existing.columns;
      let group_by = existing.group_by;

      if (source_table !== existing.source_table) {
        // Table changed → reset the column/group config.
        columns = [];
        group_by = [];
      }
      // If the client sent a column/group config, sanitize it against the
      // (possibly new) source table's live metadata.
      if (source_table && (body.columns !== undefined || body.group_by !== undefined)) {
        const live = await liveColumns(req, source_table);
        const sanitized = sanitizeConfig(
          {
            columns: body.columns ?? columns,
            group_by: body.group_by ?? group_by,
          },
          live,
        );
        columns = sanitized.columns;
        group_by = sanitized.group_by;
      }

      const { rows } = await appkit.lakebase.query<Report>(
        `UPDATE greport.reports
            SET name = $2, source_table = $3, columns = $4::jsonb, group_by = $5::jsonb,
                page_size = $6, orientation = $7, updated_at = now()
          WHERE id = $1
        RETURNING id, name, user_email, source_table, columns, group_by, page_size, orientation, created_at, updated_at`,
        [
          existing.id,
          name,
          source_table,
          JSON.stringify(columns),
          JSON.stringify(group_by),
          page_size,
          orientation,
        ],
      );
      res.json(rows[0]);
    }),
  );

  // Delete a report.
  app.delete(
    '/api/reports/:id',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      await appkit.lakebase.query(`DELETE FROM greport.reports WHERE id = $1`, [report.id]);
      res.status(204).end();
    }),
  );

  // Preview: run the query and return the banded view as JSON.
  app.post(
    '/api/reports/:id/preview',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      if (!report.source_table) throw new HttpError(400, 'Choose a source table first');
      const limit = clampLimit((req.body as Record<string, unknown>)?.limit, 500, 5000);
      const view = await buildView(appkit, ucClient(req), report, limit);
      res.json({ ...view, sql_limit: limit });
    }),
  );

  // PDF: run the query, build the banded view, render a real PDF, stream it.
  app.get(
    '/api/reports/:id/pdf',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      if (!report.source_table) throw new HttpError(400, 'Choose a source table first');
      const { pdf } = await renderReportPdf(appkit, ucClient(req), report);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(report.name)}.pdf"`);
      res.setHeader('Content-Length', pdf.length);
      res.end(pdf);
    }),
  );
}
