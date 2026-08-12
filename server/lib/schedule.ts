// Schedule model: compile presets to cron, validate cron, and compute the next
// run time in a given IANA timezone (via cron-parser).
//
// We store a canonical 5-field cron string for every schedule — presets
// (daily/weekly/monthly + time) are compiled to cron on write, and users may
// also supply a raw cron expression directly. next_run_at is then derived from
// the cron + timezone so the scheduler only has to compare timestamps.

import cronParser from 'cron-parser';
import type { Frequency } from './types.js';

export interface ScheduleSpec {
  frequency: Frequency;
  /** 0=Sunday … 6=Saturday. Used by 'weekly'. */
  weekday?: number;
  /** Day of month 1–31. Used by 'monthly'. */
  dayOfMonth?: number;
  /** Hour 0–23 (local to timezone). Used by presets. */
  hour?: number;
  /** Minute 0–59. Used by presets. */
  minute?: number;
  /** Raw cron string. Used (and required) when frequency === 'cron'. */
  cron?: string;
  timezone: string;
}

export interface CompiledSchedule {
  cron: string;
  timezone: string;
  summary: string;
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** True if `tz` is a valid IANA timezone name. */
export function isValidTimezone(tz: string): boolean {
  try {
    // Throws RangeError for an invalid timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate a 5-field cron expression (throws on invalid). Returns it trimmed. */
export function validateCron(cron: string, timezone: string): string {
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron must have exactly 5 fields: minute hour day-of-month month day-of-week');
  }
  // parseExpression throws on malformed fields.
  cronParser.parseExpression(trimmed, { tz: timezone });
  return trimmed;
}

function two(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Compile a schedule spec into a canonical cron string + human summary. */
export function compileSchedule(spec: ScheduleSpec): CompiledSchedule {
  const timezone = spec.timezone && isValidTimezone(spec.timezone) ? spec.timezone : 'UTC';
  const hour = clampInt(spec.hour, 0, 23, 8);
  const minute = clampInt(spec.minute, 0, 59, 0);
  const time = `${two(hour)}:${two(minute)}`;

  let cron: string;
  let summary: string;

  switch (spec.frequency) {
    case 'daily':
      cron = `${minute} ${hour} * * *`;
      summary = `Daily at ${time}`;
      break;
    case 'weekly': {
      const wd = clampInt(spec.weekday, 0, 6, 1);
      cron = `${minute} ${hour} * * ${wd}`;
      summary = `Weekly on ${WEEKDAYS[wd]} at ${time}`;
      break;
    }
    case 'monthly': {
      const dom = clampInt(spec.dayOfMonth, 1, 31, 1);
      cron = `${minute} ${hour} ${dom} * *`;
      summary = `Monthly on day ${dom} at ${time}`;
      break;
    }
    case 'cron': {
      if (!spec.cron) throw new Error('A cron expression is required');
      cron = validateCron(spec.cron, timezone);
      summary = `Custom schedule (${cron})`;
      break;
    }
    default:
      throw new Error(`Unknown frequency: ${String(spec.frequency)}`);
  }

  // Final validation (also catches impossible preset combos).
  validateCron(cron, timezone);
  return { cron, timezone, summary: `${summary} (${timezone})` };
}

/**
 * The next run time strictly after `from` (default now), as an ISO string.
 * Returns null if the cron somehow yields no future occurrence.
 */
export function nextRunAt(cron: string, timezone: string, from: Date = new Date()): string | null {
  try {
    const it = cronParser.parseExpression(cron, { tz: timezone, currentDate: from });
    return it.next().toISOString();
  } catch {
    return null;
  }
}
