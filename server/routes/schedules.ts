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
import { spLegacyClient } from '../lib/clients.js';
import { renderReportPdf, safeFileName } from '../lib/report-render.js';
import { sendMail, mailerConfigured } from '../lib/mailer.js';
import { compileSchedule, isValidTimezone, nextRunAt, type ScheduleSpec } from '../lib/schedule.js';
import type { Frequency, Report, Schedule, SendStatus, SendTrigger } from '../lib/types.js';

const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly', 'cron'];

const SCHEDULE_COLUMNS = `id, report_id, created_by, recipients, subject, body, cron, timezone,
  summary, enabled, next_run_at, last_run_at, created_at, updated_at`;

/** DB row shape (jsonb recipients arrive parsed). */
type ScheduleRow = Omit<Schedule, 'recipients'> & { recipients: unknown };

function toSchedule(row: ScheduleRow): Schedule {
  return {
    ...row,
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
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

/**
 * Render a report to PDF and email it, writing a send_log row either way.
 * Never throws for a "preview" (no SMTP) — only a real send failure is logged
 * as 'failed' and rethrown to the caller if `rethrow` is set.
 */
async function sendReport(
  appkit: AppKit,
  report: Report,
  schedule: Schedule | null,
  recipients: string[],
  subject: string,
  body: string,
  trigger: SendTrigger,
): Promise<{ status: SendStatus; pdfBytes: number; rowCount: number; error?: string }> {
  let pdfBytes = 0;
  let rowCount = 0;
  let status: SendStatus = 'failed';
  let error: string | undefined;

  try {
    const { pdf, rowCount: rc } = await renderReportPdf(appkit, spLegacyClient(), report);
    pdfBytes = pdf.length;
    rowCount = rc;
    const result = await sendMail({
      to: recipients,
      subject: subject || `Report: ${report.name}`,
      text:
        body ||
        `Attached is your scheduled report "${report.name}" (${rc.toLocaleString()} rows).`,
      attachments: [
        { filename: `${safeFileName(report.name)}.pdf`, content: pdf, contentType: 'application/pdf' },
      ],
    });
    status = result.status; // 'sent' or 'preview'
  } catch (e) {
    status = 'failed';
    error = e instanceof Error ? e.message : String(e);
  }

  await appkit.lakebase.query(
    `INSERT INTO greport.send_log
       (schedule_id, report_id, status, recipients, trigger, pdf_bytes, row_count, error)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      schedule?.id ?? null,
      report.id,
      status,
      JSON.stringify(recipients),
      trigger,
      pdfBytes || null,
      rowCount || null,
      error ?? null,
    ],
  );

  return { status, pdfBytes, rowCount, error };
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

  // Create a schedule.
  app.post(
    '/api/reports/:id/schedules',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const recipients = cleanRecipients(body.recipients);
      if (recipients.length === 0) throw new HttpError(400, 'At least one valid recipient is required');

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
           (report_id, created_by, recipients, subject, body, cron, timezone, summary, enabled, next_run_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, true, $9)
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
          next,
        ],
      );
      res.status(201).json(toSchedule(rows[0]));
    }),
  );

  // Update a schedule (recipients / cadence / enabled / subject / body).
  app.patch(
    '/api/schedules/:id',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const existing = await requireScheduleOwner(appkit, param(req, 'id'), email);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const recipients =
        body.recipients !== undefined ? cleanRecipients(body.recipients) : existing.recipients;
      if (recipients.length === 0) throw new HttpError(400, 'At least one valid recipient is required');

      const subject = typeof body.subject === 'string' ? body.subject.trim() : existing.subject;
      const emailBody = typeof body.body === 'string' ? body.body.trim() : existing.body;
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : existing.enabled;

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
                summary = $7, enabled = $8, next_run_at = $9, updated_at = now()
          WHERE id = $1
        RETURNING ${SCHEDULE_COLUMNS}`,
        [existing.id, JSON.stringify(recipients), subject, emailBody, cron, timezone, summary, enabled, next],
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

  // Send now (manual trigger for a report to a schedule's — or ad-hoc — recipients).
  app.post(
    '/api/reports/:id/send-now',
    asyncHandler(async (req, res) => {
      const email = currentEmail(req);
      const report = await requireOwner(appkit, param(req, 'id'), email);
      if (!report.source_table) throw new HttpError(400, 'Choose a source table first');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const recipients = cleanRecipients(body.recipients);
      if (recipients.length === 0) throw new HttpError(400, 'At least one valid recipient is required');
      const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
      const emailBody = typeof body.body === 'string' ? body.body.trim() : '';

      const result = await sendReport(appkit, report, null, recipients, subject, emailBody, 'manual');
      if (result.status === 'failed') throw new HttpError(502, result.error ?? 'Send failed');
      res.json({ status: result.status, pdf_bytes: result.pdfBytes, row_count: result.rowCount });
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

        const result = await sendReport(
          appkit,
          report,
          schedule,
          schedule.recipients,
          schedule.subject,
          schedule.body,
          'schedule',
        );
        await appkit.lakebase.query(
          `UPDATE greport.schedules SET last_run_at = now(), next_run_at = $2, updated_at = now() WHERE id = $1`,
          [schedule.id, next],
        );
        processed.push({ schedule_id: schedule.id, status: result.status });
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
