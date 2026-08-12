// Email-schedule CRUD, a manual "Send now" endpoint, and the scheduler tick.
//
// A schedule attaches recipients + a cron cadence to a report. The app itself
// cannot reliably run a timer (Databricks Apps scale to zero), so an external
// Databricks Job hits POST /api/scheduler/tick on a cron; that endpoint finds
// due schedules, renders each report's PDF (as the service principal), emails
// it, logs the attempt, and advances next_run_at. The tick is gated by a shared
// secret so only the Job can trigger it.

import type { Application, Request } from 'express';
import type { AppKit } from '../lib/appkit.js';
import { asyncHandler, param } from '../lib/http.js';
import { currentEmail, HttpError, requireOwner, getReport } from '../lib/access.js';
import { spLegacyClient, ucClient } from '../lib/clients.js';
import {
  renderReportPdf,
  safeFileName,
  liveColumns,
  distinctValues,
} from '../lib/report-render.js';
import { sendMail, mailerConfigured } from '../lib/mailer.js';
import { compileSchedule, isValidTimezone, nextRunAt, type ScheduleSpec } from '../lib/schedule.js';
import type { ReportFilter } from '../lib/sql.js';
import type {
  DeliveryMode,
  Frequency,
  RecipientMapEntry,
  Report,
  Schedule,
  SendStatus,
  SendTrigger,
} from '../lib/types.js';

const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly', 'cron'];

const SCHEDULE_COLUMNS = `id, report_id, created_by, recipients, subject, body, cron, timezone,
  summary, enabled, mode, split_column, recipient_map, next_run_at, last_run_at, created_at, updated_at`;

/** DB row shape (jsonb columns arrive parsed). */
type ScheduleRow = Omit<Schedule, 'recipients' | 'recipient_map'> & {
  recipients: unknown;
  recipient_map: unknown;
};

function toSchedule(row: ScheduleRow): Schedule {
  return {
    ...row,
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
    recipient_map: Array.isArray(row.recipient_map)
      ? (row.recipient_map as RecipientMapEntry[])
      : [],
  };
}

/** Basic email-shape validation; returns the cleaned, de-duplicated list. */
function cleanRecipients(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (typeof r !== 'string') continue;
    const email = r.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}

/** Sanitize a client-supplied recipient map (drops entries with no valid emails). */
function cleanRecipientMap(raw: unknown): RecipientMapEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: RecipientMapEntry[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const rawValue = e.value;
    const value =
      rawValue === null || rawValue === undefined
        ? null
        : typeof rawValue === 'object'
          ? JSON.stringify(rawValue)
          : String(rawValue as string | number | boolean);
    const recipients = cleanRecipients(e.recipients);
    if (recipients.length === 0) continue; // no point routing to nobody
    out.push({ value, recipients });
  }
  return out;
}

/** The report's column type for a given column name (for building a filter). */
function columnType(report: Report, name: string): ReportFilter['type'] {
  const c = report.columns.find((col) => col.name === name);
  return c ? c.type : 'string';
}

interface DeliverySpec {
  mode: DeliveryMode;
  recipients: string[];
  splitColumn: string | null;
  recipientMap: RecipientMapEntry[];
}

/**
 * Validate the delivery configuration from a request body against the report.
 * - single: `recipients` must be non-empty.
 * - split:  `split_column` must be a group-by column, and `recipient_map` must
 *           have at least one entry with valid recipients.
 * Throws HttpError(400) on any problem.
 */
function parseDelivery(body: Record<string, unknown>, report: Report): DeliverySpec {
  const mode: DeliveryMode = body.mode === 'split' ? 'split' : 'single';

  if (mode === 'split') {
    const splitColumn = typeof body.split_column === 'string' ? body.split_column : '';
    if (!report.group_by.includes(splitColumn)) {
      throw new HttpError(400, 'split_column must be one of the report’s group-by columns');
    }
    const recipientMap = cleanRecipientMap(body.recipient_map);
    if (recipientMap.length === 0) {
      throw new HttpError(400, 'Split delivery needs at least one group mapped to recipients');
    }
    // recipients (single-mode list) is irrelevant in split mode; keep empty.
    return { mode, recipients: [], splitColumn, recipientMap };
  }

  const recipients = cleanRecipients(body.recipients);
  if (recipients.length === 0) {
    throw new HttpError(400, 'At least one valid recipient is required');
  }
  return { mode, recipients, splitColumn: null, recipientMap: [] };
}

/** Parse + validate the schedule spec from a request body. */
function parseSpec(body: Record<string, unknown>): ScheduleSpec {
  const frequency = FREQUENCIES.includes(body.frequency as Frequency)
    ? (body.frequency as Frequency)
    : 'weekly';
  const timezone =
    typeof body.timezone === 'string' && isValidTimezone(body.timezone) ? body.timezone : 'UTC';
  return {
    frequency,
    weekday: body.weekday === undefined ? undefined : Number(body.weekday),
    dayOfMonth: body.dayOfMonth === undefined ? undefined : Number(body.dayOfMonth),
    hour: body.hour === undefined ? undefined : Number(body.hour),
    minute: body.minute === undefined ? undefined : Number(body.minute),
    cron: typeof body.cron === 'string' ? body.cron : undefined,
    timezone,
  };
}

interface SendOutcome {
  status: SendStatus;
  pdfBytes: number;
  rowCount: number;
  error?: string;
}

/**
 * Render a report (optionally filtered to one group value) to PDF, email it,
 * and write a send_log row. Never throws — a failure is captured as status
 * 'failed'. `groupValue` is recorded on the log row for split sends.
 */
async function sendOne(
  appkit: AppKit,
  report: Report,
  scheduleId: string | null,
  recipients: string[],
  subject: string,
  body: string,
  trigger: SendTrigger,
  filter?: ReportFilter,
  groupValue?: string | null,
): Promise<SendOutcome> {
  let pdfBytes = 0;
  let rowCount = 0;
  let status: SendStatus = 'failed';
  let error: string | undefined;

  const groupSuffix = groupValue ? ` — ${groupValue}` : '';
  try {
    const { pdf, rowCount: rc } = await renderReportPdf(appkit, spLegacyClient(), report, filter);
    pdfBytes = pdf.length;
    rowCount = rc;
    const fileStem = safeFileName(groupValue ? `${report.name}-${groupValue}` : report.name);
    const result = await sendMail({
      to: recipients,
      subject: (subject || `Report: ${report.name}`) + groupSuffix,
      text:
        (body || `Attached is your scheduled report "${report.name}${groupSuffix}"`) +
        ` (${rc.toLocaleString()} rows).`,
      attachments: [
        { filename: `${fileStem}.pdf`, content: pdf, contentType: 'application/pdf' },
      ],
    });
    status = result.status; // 'sent' or 'preview'
  } catch (e) {
    status = 'failed';
    error = e instanceof Error ? e.message : String(e);
  }

  await appkit.lakebase.query(
    `INSERT INTO greport.send_log
       (schedule_id, report_id, status, recipients, trigger, pdf_bytes, row_count, group_value, error)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
    [
      scheduleId,
      report.id,
      status,
      JSON.stringify(recipients),
      trigger,
      pdfBytes || null,
      rowCount || null,
      groupValue ?? null,
      error ?? null,
    ],
  );

  return { status, pdfBytes, rowCount, error };
}

/** Result of a delivery: per-slice outcomes (one for 'single', N for 'split'). */
interface DeliveryResult {
  slices: { group_value: string | null; status: SendStatus; row_count: number; error?: string }[];
}

/**
 * Deliver a report for a schedule (or ad-hoc params). In 'single' mode this is
 * one PDF to `recipients`; in 'split' mode it bursts by `splitColumn`, rendering
 * one filtered PDF per recipient_map entry and routing it to that entry's
 * recipients. Each slice is logged separately.
 */
async function deliver(
  appkit: AppKit,
  report: Report,
  opts: {
    scheduleId: string | null;
    mode: DeliveryMode;
    recipients: string[];
    subject: string;
    body: string;
    splitColumn: string | null;
    recipientMap: RecipientMapEntry[];
    trigger: SendTrigger;
  },
): Promise<DeliveryResult> {
  if (opts.mode === 'split' && opts.splitColumn) {
    const type = columnType(report, opts.splitColumn);
    const slices: DeliveryResult['slices'] = [];
    for (const entry of opts.recipientMap) {
      const filter: ReportFilter = { column: opts.splitColumn, value: entry.value, type };
      const outcome = await sendOne(
        appkit,
        report,
        opts.scheduleId,
        entry.recipients,
        opts.subject,
        opts.body,
        opts.trigger,
        filter,
        entry.value,
      );
      slices.push({
        group_value: entry.value,
        status: outcome.status,
        row_count: outcome.rowCount,
        error: outcome.error,
      });
    }
    return { slices };
  }

  // Single mode.
  const outcome = await sendOne(
    appkit,
    report,
    opts.scheduleId,
    opts.recipients,
    opts.subject,
    opts.body,
    opts.trigger,
  );
  return {
    slices: [
      { group_value: null, status: outcome.status, row_count: outcome.rowCount, error: outcome.error },
    ],
  };
}

export function registerScheduleRoutes(app: Application, appkit: AppKit): void {
  // List a report's schedules (+ its last send-log entry).
  app.get(
    '/api/reports/:id/schedules',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      await requireOwner(appkit, param(req, 'id'), email);
      const { rows } = await appkit.lakebase.query<ScheduleRow>(
        `SELECT ${SCHEDULE_COLUMNS} FROM greport.schedules
          WHERE report_id = $1 ORDER BY created_at`,
        [param(req, 'id')],
      );
      res.json({
        mailerConfigured: mailerConfigured(),
        schedules: rows.map(toSchedule),
      });
    }),
  );

  // Distinct values of a group column (for building the split recipient map).
  app.get(
    '/api/reports/:id/group-values',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      if (!report.source_table) throw new HttpError(400, 'Choose a source table first');
      const column = typeof req.query.column === 'string' ? req.query.column : '';
      if (!report.group_by.includes(column)) {
        throw new HttpError(400, 'column must be one of the report’s group-by columns');
      }
      const live = await liveColumns(ucClient(req), report.source_table);
      const values = await distinctValues(appkit, report, column, live);
      res.json({ column, values });
    }),
  );

  // Create a schedule.
  app.post(
    '/api/reports/:id/schedules',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const { mode, splitColumn, recipientMap, recipients } = parseDelivery(body, report);

      let compiled;
      try {
        compiled = compileSchedule(parseSpec(body));
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'Invalid schedule');
      }
      const next = nextRunAt(compiled.cron, compiled.timezone);
      const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
      const emailBody = typeof body.body === 'string' ? body.body.trim() : '';

      const { rows } = await appkit.lakebase.query<ScheduleRow>(
        `INSERT INTO greport.schedules
           (report_id, created_by, recipients, subject, body, cron, timezone, summary, enabled,
            mode, split_column, recipient_map, next_run_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, true, $9, $10, $11::jsonb, $12)
         RETURNING ${SCHEDULE_COLUMNS}`,
        [
          report.id,
          email,
          JSON.stringify(recipients),
          subject,
          emailBody,
          compiled.cron,
          compiled.timezone,
          compiled.summary,
          mode,
          splitColumn,
          JSON.stringify(recipientMap),
          next,
        ],
      );
      res.status(201).json(toSchedule(rows[0]));
    }),
  );

  // Update a schedule (recipients / cadence / enabled / subject / body / delivery).
  app.patch(
    '/api/schedules/:id',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const existing = await requireScheduleOwner(appkit, param(req, 'id'), email);
      const report = await getReport(appkit, existing.report_id);
      if (!report) throw new HttpError(404, 'Report not found');
      const body = (req.body ?? {}) as Record<string, unknown>;

      const subject = typeof body.subject === 'string' ? body.subject.trim() : existing.subject;
      const emailBody = typeof body.body === 'string' ? body.body.trim() : existing.body;
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : existing.enabled;

      // Recompute delivery only if any delivery field was supplied; otherwise
      // keep the existing mode/recipients/map untouched (e.g. an enable toggle).
      let mode = existing.mode;
      let recipients = existing.recipients;
      let splitColumn = existing.split_column;
      let recipientMap = existing.recipient_map;
      const deliveryTouched = ['mode', 'recipients', 'split_column', 'recipient_map'].some(
        (k) => body[k] !== undefined,
      );
      if (deliveryTouched) {
        // Merge onto existing so a partial patch (e.g. only recipient_map) keeps mode.
        const merged: Record<string, unknown> = {
          mode: body.mode ?? existing.mode,
          recipients: body.recipients ?? existing.recipients,
          split_column: body.split_column ?? existing.split_column,
          recipient_map: body.recipient_map ?? existing.recipient_map,
        };
        const d = parseDelivery(merged, report);
        mode = d.mode;
        recipients = d.recipients;
        splitColumn = d.splitColumn;
        recipientMap = d.recipientMap;
      }

      // Recompute cron only if any cadence field was supplied.
      let cron = existing.cron;
      let timezone = existing.timezone;
      let summary = existing.summary;
      const cadenceTouched =
        ['frequency', 'weekday', 'dayOfMonth', 'hour', 'minute', 'cron', 'timezone'].some(
          (k) => body[k] !== undefined,
        );
      if (cadenceTouched) {
        try {
          const compiled = compileSchedule(parseSpec(body));
          cron = compiled.cron;
          timezone = compiled.timezone;
          summary = compiled.summary;
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : 'Invalid schedule');
        }
      }
      // Recompute next run when cadence changed or the schedule was re-enabled.
      const next =
        enabled && (cadenceTouched || !existing.enabled)
          ? nextRunAt(cron, timezone)
          : enabled
            ? existing.next_run_at
            : null;

      const { rows } = await appkit.lakebase.query<ScheduleRow>(
        `UPDATE greport.schedules
            SET recipients = $2::jsonb, subject = $3, body = $4, cron = $5, timezone = $6,
                summary = $7, enabled = $8, mode = $9, split_column = $10,
                recipient_map = $11::jsonb, next_run_at = $12, updated_at = now()
          WHERE id = $1
        RETURNING ${SCHEDULE_COLUMNS}`,
        [
          existing.id,
          JSON.stringify(recipients),
          subject,
          emailBody,
          cron,
          timezone,
          summary,
          enabled,
          mode,
          splitColumn,
          JSON.stringify(recipientMap),
          next,
        ],
      );
      res.json(toSchedule(rows[0]));
    }),
  );

  // Delete a schedule.
  app.delete(
    '/api/schedules/:id',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const existing = await requireScheduleOwner(appkit, param(req, 'id'), email);
      await appkit.lakebase.query(`DELETE FROM greport.schedules WHERE id = $1`, [existing.id]);
      res.status(204).end();
    }),
  );

  // Send now (manual trigger). Accepts ad-hoc single or split delivery params.
  app.post(
    '/api/reports/:id/send-now',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      if (!report.source_table) throw new HttpError(400, 'Choose a source table first');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const d = parseDelivery(body, report);
      const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
      const emailBody = typeof body.body === 'string' ? body.body.trim() : '';

      const result = await deliver(appkit, report, {
        scheduleId: null,
        mode: d.mode,
        recipients: d.recipients,
        subject,
        body: emailBody,
        splitColumn: d.splitColumn,
        recipientMap: d.recipientMap,
        trigger: 'manual',
      });

      const failures = result.slices.filter((s) => s.status === 'failed');
      if (failures.length === result.slices.length) {
        throw new HttpError(502, failures[0]?.error ?? 'Send failed');
      }
      res.json({
        mode: d.mode,
        slices: result.slices.map((s) => ({
          group_value: s.group_value,
          status: s.status,
          row_count: s.row_count,
        })),
      });
    }),
  );

  // Scheduler tick — called by the external Databricks Job. Secret-gated.
  app.post(
    '/api/scheduler/tick',
    asyncHandler(async (req, res) => {
      requireSchedulerAuth(req);

      // Claim all due schedules. (Single-instance app; a simple SELECT is fine.)
      const { rows } = await appkit.lakebase.query<ScheduleRow>(
        `SELECT ${SCHEDULE_COLUMNS} FROM greport.schedules
          WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
          ORDER BY next_run_at
          LIMIT 50`,
      );

      const processed: { schedule_id: string; status: string }[] = [];
      for (const row of rows) {
        const schedule = toSchedule(row);
        const report = await getReport(appkit, schedule.report_id);
        // Always advance next_run_at so a broken schedule can't hot-loop.
        const next = nextRunAt(schedule.cron, schedule.timezone);

        if (!report || !report.source_table || report.columns.length === 0) {
          await appkit.lakebase.query(
            `UPDATE greport.schedules SET last_run_at = now(), next_run_at = $2, updated_at = now() WHERE id = $1`,
            [schedule.id, next],
          );
          await appkit.lakebase.query(
            `INSERT INTO greport.send_log (schedule_id, report_id, status, recipients, trigger, error)
             VALUES ($1, $2, 'failed', $3::jsonb, 'schedule', $4)`,
            [
              schedule.id,
              schedule.report_id,
              JSON.stringify(schedule.recipients),
              'Report is not configured (no table/columns).',
            ],
          );
          processed.push({ schedule_id: schedule.id, status: 'failed' });
          continue;
        }

        const result = await deliver(appkit, report, {
          scheduleId: schedule.id,
          mode: schedule.mode,
          recipients: schedule.recipients,
          subject: schedule.subject,
          body: schedule.body,
          splitColumn: schedule.split_column,
          recipientMap: schedule.recipient_map,
          trigger: 'schedule',
        });
        await appkit.lakebase.query(
          `UPDATE greport.schedules SET last_run_at = now(), next_run_at = $2, updated_at = now() WHERE id = $1`,
          [schedule.id, next],
        );
        // Summarize slice statuses for the tick response.
        const anyFail = result.slices.some((s) => s.status === 'failed');
        const anyOk = result.slices.some((s) => s.status !== 'failed');
        const status = anyFail ? (anyOk ? 'partial' : 'failed') : (result.slices[0]?.status ?? 'preview');
        processed.push({ schedule_id: schedule.id, status });
      }

      res.json({ processed: processed.length, results: processed });
    }),
  );
}

/** Resolve a schedule and assert the caller owns its report; returns the schedule. */
async function requireScheduleOwner(
  appkit: AppKit,
  scheduleId: string,
  email: string,
): Promise<Schedule> {
  const { rows } = await appkit.lakebase.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM greport.schedules WHERE id = $1`,
    [scheduleId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Schedule not found');
  // Reuse report ownership check.
  await requireOwner(appkit, row.report_id, email);
  return toSchedule(row);
}

/** Gate the scheduler tick behind a shared secret (constant-time compare). */
function requireSchedulerAuth(req: Request): void {
  const expected = process.env.SCHEDULER_TOKEN;
  if (!expected) {
    // Fail closed: without a configured token the tick endpoint is disabled.
    throw new HttpError(503, 'Scheduler not configured');
  }
  const got = req.header('x-scheduler-token') ?? '';
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new HttpError(401, 'Unauthorized');
  }
}

/** Length-checked constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
