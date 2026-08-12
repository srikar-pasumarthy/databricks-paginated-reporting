// Current-user resolution and report access control.
//
// Reports are private to their owner: only the user who created a report can
// view, edit, render, or delete it. Ownership is by the forwarded user email.

import type { Request } from 'express';
import type { AppKit } from './appkit.js';
import type { Report } from './types.js';

const DEV_EMAIL = 'dev.user@databricks.com';

/** Resolve the current user's email from Databricks Apps headers. */
export function currentEmail(req: Request): string {
  const email =
    req.header('x-forwarded-email') ??
    req.header('x-forwarded-user') ??
    req.header('x-forwarded-preferred-username');
  if (email) return email;
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[access] No x-forwarded-email header; using dev fallback', DEV_EMAIL);
    return DEV_EMAIL;
  }
  throw new HttpError(401, 'Unauthenticated: missing user identity');
}

/** A typed error carrying an HTTP status; caught by the asyncHandler wrapper. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const REPORT_COLUMNS = `id, name, user_email, source_table, columns, group_by,
  page_size, orientation, created_at, updated_at`;

/** Row shape as stored in Postgres (jsonb columns arrive parsed as objects). */
type ReportRow = Omit<Report, 'columns' | 'group_by'> & {
  columns: unknown;
  group_by: unknown;
};

function toReport(row: ReportRow): Report {
  return {
    ...row,
    columns: Array.isArray(row.columns) ? (row.columns as Report['columns']) : [],
    group_by: Array.isArray(row.group_by) ? (row.group_by as string[]) : [],
  };
}

export async function getReport(appkit: AppKit, id: string): Promise<Report | null> {
  const { rows } = await appkit.lakebase.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM greport.reports WHERE id = $1`,
    [id],
  );
  return rows[0] ? toReport(rows[0]) : null;
}

/** Throw 404 if missing, 403 unless the caller owns the report; returns it. */
export async function requireOwner(appkit: AppKit, id: string, email: string): Promise<Report> {
  const report = await getReport(appkit, id);
  if (!report) throw new HttpError(404, 'Report not found');
  if (report.user_email !== email) throw new HttpError(403, 'Access denied');
  return report;
}
