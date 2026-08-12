// Idempotent Lakebase (Postgres) schema initialization.
// Runs once at startup from onPluginsReady. All objects live in the `greport`
// schema (kept distinct from the older `app` schema on the same Lakebase).
//
// A report's column/group configuration is stored as JSONB so the shape can
// evolve without migrations; the server validates every identifier against
// live Unity Catalog metadata before it is ever used to build SQL.

import type { AppKit } from '../lib/appkit.js';

const STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS greport`,
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  `CREATE TABLE IF NOT EXISTS greport.reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    user_email text NOT NULL,
    source_table text,
    columns jsonb NOT NULL DEFAULT '[]',
    group_by jsonb NOT NULL DEFAULT '[]',
    page_size varchar(8) NOT NULL DEFAULT 'A4' CHECK (page_size IN ('A4', 'Letter')),
    orientation varchar(10) NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait', 'landscape')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_user_email ON greport.reports(user_email)`,

  // Email schedules: one per (report, recipients, cadence). The cron string is
  // canonical (presets are compiled to cron on write); next_run_at is what the
  // scheduler polls. Timezone is an IANA name used to interpret the cron.
  `CREATE TABLE IF NOT EXISTS greport.schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL REFERENCES greport.reports(id) ON DELETE CASCADE,
    created_by text NOT NULL,
    recipients jsonb NOT NULL DEFAULT '[]',
    subject text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    cron text NOT NULL,
    timezone text NOT NULL DEFAULT 'UTC',
    summary text NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true,
    next_run_at timestamptz,
    last_run_at timestamptz,
    -- Delivery mode: single = one PDF of the whole report to recipients;
    -- split = report bursting, one filtered PDF per value of split_column
    -- routed to that value's recipients in recipient_map.
    mode varchar(8) NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'split')),
    split_column text,
    recipient_map jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_report ON greport.schedules(report_id)`,
  // The scheduler polls this: enabled schedules whose next_run_at is due.
  `CREATE INDEX IF NOT EXISTS idx_schedules_due ON greport.schedules(next_run_at) WHERE enabled`,
  // Idempotent add-columns for schemas created before split delivery existed.
  `ALTER TABLE greport.schedules ADD COLUMN IF NOT EXISTS mode varchar(8) NOT NULL DEFAULT 'single'`,
  `ALTER TABLE greport.schedules ADD COLUMN IF NOT EXISTS split_column text`,
  `ALTER TABLE greport.schedules ADD COLUMN IF NOT EXISTS recipient_map jsonb NOT NULL DEFAULT '[]'`,

  // Audit log of every send attempt (real or preview).
  `CREATE TABLE IF NOT EXISTS greport.send_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id uuid REFERENCES greport.schedules(id) ON DELETE SET NULL,
    report_id uuid REFERENCES greport.reports(id) ON DELETE SET NULL,
    status varchar(12) NOT NULL CHECK (status IN ('sent', 'preview', 'failed')),
    recipients jsonb NOT NULL DEFAULT '[]',
    trigger varchar(12) NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
    pdf_bytes integer,
    row_count integer,
    -- For split (burst) sends: which group value this row was for.
    group_value text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_send_log_schedule ON greport.send_log(schedule_id)`,
  `CREATE INDEX IF NOT EXISTS idx_send_log_report ON greport.send_log(report_id)`,
  `ALTER TABLE greport.send_log ADD COLUMN IF NOT EXISTS group_value text`,
];

export async function initSchema(appkit: AppKit): Promise<void> {
  for (const stmt of STATEMENTS) {
    await appkit.lakebase.query(stmt);
  }
  console.log('[db] Schema ready (greport.reports, schedules, send_log)');
}
