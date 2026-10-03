import { Cron } from 'croner';
import { z } from 'zod';

/**
 * Schedule trigger (Part 23): friendly schedule kinds compile to a 5-field cron expression
 * evaluated in an explicit IANA timezone. Pure — no database, clock or queue; the cron
 * library stays behind this module so it can be swapped.
 *
 * DST (FR-23.8), as implemented by the library and pinned by tests:
 * - a wall-clock time that does not exist (spring forward) runs once, shifted forward by the
 *   gap (02:30 → 03:30 in America/New_York);
 * - a wall-clock time that occurs twice (fall back) runs once, at its first occurrence; the
 *   repeated hour is not run again, also for interval schedules.
 */

/** Interval lengths that divide the hour or the day, so occurrences align to :00 / 00:00. */
export const INTERVAL_MINUTES = [
  1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440,
] as const;

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** IANA identifiers like "Africa/Johannesburg" or "UTC"; never a raw offset or abbreviation. */
export function isValidTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  if (!value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezone = z
  .string()
  .max(64)
  .refine(isValidTimeZone, 'Use an IANA timezone such as "Africa/Johannesburg" or "UTC"');
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time "HH:mm", e.g. "07:00"');

const scheduleSpec = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('interval'),
      timezone,
      everyMinutes: z
        .number()
        .int()
        .refine((n) => (INTERVAL_MINUTES as readonly number[]).includes(n), {
          message: `everyMinutes must divide the hour or the day: ${INTERVAL_MINUTES.join(', ')}`,
        }),
    })
    .strict(),
  z
    .object({ kind: z.literal('hourly'), timezone, minute: z.number().int().min(0).max(59) })
    .strict(),
  z.object({ kind: z.literal('daily'), timezone, time }).strict(),
  z.object({ kind: z.literal('weekdays'), timezone, time }).strict(),
  z
    .object({
      kind: z.literal('weekly'),
      timezone,
      time,
      // ISO weekdays: 1 = Monday … 7 = Sunday.
      daysOfWeek: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, 'Days must not repeat'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('monthly'),
      timezone,
      time,
      // Days 29–31 skip months without that day; "last" is the last day of every month.
      dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('last')]),
    })
    .strict(),
  z
    .object({ kind: z.literal('cron'), timezone, expression: z.string().trim().min(1).max(120) })
    .strict(),
]);

export type ScheduleSpec = z.infer<typeof scheduleSpec>;

export interface CompiledSchedule {
  cron: string;
  timezone: string;
}

/** Friendly kind → cron. Assumes a spec that passed the schema. */
export function compileSchedule(spec: ScheduleSpec): CompiledSchedule {
  const at = (hhmm: string) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    return `${mm} ${hh}`;
  };
  const cron = (() => {
    switch (spec.kind) {
      case 'interval':
        if (spec.everyMinutes === 1) return '* * * * *';
        if (spec.everyMinutes < 60) return `*/${spec.everyMinutes} * * * *`;
        if (spec.everyMinutes === 1440) return '0 0 * * *';
        if (spec.everyMinutes === 60) return '0 * * * *';
        return `0 */${spec.everyMinutes / 60} * * *`;
      case 'hourly':
        return `${spec.minute} * * * *`;
      case 'daily':
        return `${at(spec.time)} * * *`;
      case 'weekdays':
        return `${at(spec.time)} * * 1-5`;
      case 'weekly':
        return `${at(spec.time)} * * ${[...spec.daysOfWeek]
          .sort((a, b) => a - b)
          .map((d) => d % 7)
          .join(',')}`;
      case 'monthly':
        return `${at(spec.time)} ${spec.dayOfMonth === 'last' ? 'L' : spec.dayOfMonth} * *`;
      case 'cron':
        return spec.expression.split(/\s+/).join(' ');
    }
  })();
  return { cron, timezone: spec.timezone };
}

/** The first occurrence strictly after `after`, or null if the schedule never fires again. */
export function nextOccurrence(schedule: CompiledSchedule, after: Date): Date | null {
  const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
  let from = after;
  // The library is strictly-after for single steps; guard anyway (a repeat would stall
  // the evaluator on one occurrence).
  for (let i = 0; i < 3; i++) {
    const next = cron.nextRun(from);
    if (!next) return null;
    if (next.getTime() > after.getTime()) return next;
    from = new Date(from.getTime() + 1_000);
  }
  return null;
}

/** The next `count` occurrences after `after`. */
export function nextOccurrences(schedule: CompiledSchedule, after: Date, count: number): Date[] {
  const result: Date[] = [];
  let from = after;
  while (result.length < count) {
    const next = nextOccurrence(schedule, from);
    if (!next) break;
    result.push(next);
    from = next;
  }
  return result;
}

/**
 * Misfire policy (FR-23.7): of the occurrences due at `now` (from `dueSince`, the stored
 * nextRunAt, inclusive), fire only the latest, and only if it is within `graceMs`; all others
 * are skipped. Occurrences older than the grace window are never examined one by one.
 */
export function dueOccurrence(
  schedule: CompiledSchedule,
  dueSince: Date,
  now: Date,
  graceMs: number,
): { fire: Date | null; skipped: number; skippedBeforeWindow: boolean; next: Date | null } {
  const windowStart = new Date(Math.max(dueSince.getTime() - 1, now.getTime() - graceMs));
  let latest: Date | null = null;
  let within = 0;
  let cursor = nextOccurrence(schedule, windowStart);
  while (cursor && cursor.getTime() <= now.getTime()) {
    latest = cursor;
    within++;
    cursor = nextOccurrence(schedule, cursor);
  }
  return {
    fire: latest,
    skipped: Math.max(within - 1, 0),
    skippedBeforeWindow: dueSince.getTime() < windowStart.getTime(),
    next: cursor,
  };
}

/** Smallest gap between consecutive occurrences over a sample, in minutes. */
function minGapMinutes(schedule: CompiledSchedule, from: Date, sample = 60): number {
  const runs = nextOccurrences(schedule, from, sample);
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) {
    min = Math.min(min, (runs[i].getTime() - runs[i - 1].getTime()) / 60_000);
  }
  return min;
}

/** Validation beyond the shape: cron syntax, "fires at all", and the server's minimum gap. */
function checkFires(
  spec: ScheduleSpec,
  minIntervalMinutes: number,
  ctx: z.RefinementCtx,
  now: Date,
): void {
  // Field refinements leave the result "dirty", not aborted, so this still runs after one of
  // them failed; only a fully valid shape may reach the cron library.
  if (!scheduleSpec.safeParse(spec).success) return;
  if (spec.kind === 'cron') {
    const fields = spec.expression.split(/\s+/);
    if (fields.length !== 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expression'],
        message: 'Use a standard 5-field cron expression (minute hour day month weekday)',
      });
      return;
    }
    try {
      new Cron(spec.expression, { timezone: spec.timezone, paused: true });
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expression'],
        message: `Invalid cron expression: ${(err as Error).message}`,
      });
      return;
    }
  }
  const compiled = compileSchedule(spec);
  if (!nextOccurrence(compiled, now)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'This schedule never runs' });
    return;
  }
  if (minGapMinutes(compiled, now) < minIntervalMinutes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path:
        spec.kind === 'interval' ? ['everyMinutes'] : spec.kind === 'cron' ? ['expression'] : [],
      message: `Schedules on this server run at most every ${minIntervalMinutes} minute${minIntervalMinutes === 1 ? '' : 's'}`,
    });
  }
}

/** Config of the `schedule.trigger` node: `{ schedule: { kind, timezone, … } }` (FR-23.1). */
export function scheduleConfigSchema(
  minIntervalMinutes: number,
  clock: () => Date = () => new Date(),
) {
  return z
    .object({
      schedule: scheduleSpec.superRefine((spec, ctx) =>
        checkFires(spec, minIntervalMinutes, ctx, clock()),
      ),
    })
    .strict();
}

export type ScheduleTriggerConfig = { schedule: ScheduleSpec };

/** Human-readable summary for the workflow list, e.g. "Weekdays at 07:00 (Africa/Johannesburg)". */
export function describeSchedule(spec: ScheduleSpec): string {
  const when = (() => {
    switch (spec.kind) {
      case 'interval':
        return spec.everyMinutes === 1 ? 'Every minute' : `Every ${spec.everyMinutes} minutes`;
      case 'hourly':
        return `Hourly at :${String(spec.minute).padStart(2, '0')}`;
      case 'daily':
        return `Daily at ${spec.time}`;
      case 'weekdays':
        return `Weekdays at ${spec.time}`;
      case 'weekly':
        return `Weekly on ${[...spec.daysOfWeek]
          .sort((a, b) => a - b)
          .map((d) => DAY_NAMES[d])
          .join(', ')} at ${spec.time}`;
      case 'monthly':
        return spec.dayOfMonth === 'last'
          ? `Monthly on the last day at ${spec.time}`
          : `Monthly on day ${spec.dayOfMonth} at ${spec.time}`;
      case 'cron':
        return `Cron "${spec.expression}"`;
    }
  })();
  return `${when} (${spec.timezone})`;
}
