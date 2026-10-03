import {
  compileSchedule,
  describeSchedule,
  dueOccurrence,
  isValidTimeZone,
  nextOccurrence,
  nextOccurrences,
  scheduleConfigSchema,
  ScheduleSpec,
} from './schedule';
import { scheduleNodeType, scheduleTriggerHandler } from './schedule-node-type';

const NOW = new Date('2026-10-03T10:00:00.000Z');
const schema = scheduleConfigSchema(5, () => NOW);
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const next = (spec: ScheduleSpec, from: string, count = 3) =>
  iso(nextOccurrences(compileSchedule(spec), new Date(from), count));
const issues = (schedule: unknown, s = schema) => {
  const result = s.safeParse({ schedule });
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('schedule (Part 23)', () => {
  describe('config schema (FR-23.1/23.2/23.3)', () => {
    it.each<[string, ScheduleSpec, string]>([
      ['interval', { kind: 'interval', timezone: 'UTC', everyMinutes: 15 }, '*/15 * * * *'],
      ['interval 2h', { kind: 'interval', timezone: 'UTC', everyMinutes: 120 }, '0 */2 * * *'],
      ['interval 1h', { kind: 'interval', timezone: 'UTC', everyMinutes: 60 }, '0 * * * *'],
      ['interval 1d', { kind: 'interval', timezone: 'UTC', everyMinutes: 1440 }, '0 0 * * *'],
      ['hourly', { kind: 'hourly', timezone: 'UTC', minute: 5 }, '5 * * * *'],
      ['daily', { kind: 'daily', timezone: 'UTC', time: '07:30' }, '30 7 * * *'],
      ['weekdays', { kind: 'weekdays', timezone: 'UTC', time: '07:00' }, '0 7 * * 1-5'],
      [
        'weekly',
        { kind: 'weekly', timezone: 'UTC', time: '16:00', daysOfWeek: [7, 1, 5] },
        '0 16 * * 1,5,0',
      ],
      ['monthly', { kind: 'monthly', timezone: 'UTC', time: '09:00', dayOfMonth: 1 }, '0 9 1 * *'],
      [
        'monthly last',
        { kind: 'monthly', timezone: 'UTC', time: '09:00', dayOfMonth: 'last' },
        '0 9 L * *',
      ],
      ['cron', { kind: 'cron', timezone: 'UTC', expression: '0  7 * * 1-5' }, '0 7 * * 1-5'],
    ])('%s validates and compiles', (_name, spec, cron) => {
      expect(issues(spec)).toEqual([]);
      expect(compileSchedule(spec).cron).toBe(cron);
    });

    it('requires an explicit IANA timezone (never defaulted)', () => {
      expect(issues({ kind: 'daily', time: '07:00' })).toHaveLength(1);
      for (const tz of ['Mars/Olympus', '+02:00', 'GMT+2', 'SAST', '', 'Europe/../etc']) {
        expect(issues({ kind: 'daily', timezone: tz, time: '07:00' })).toEqual([
          expect.stringContaining('IANA timezone'),
        ]);
      }
      expect(isValidTimeZone('Africa/Johannesburg')).toBe(true);
      expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
    });

    it('rejects malformed values with clear messages', () => {
      expect(issues({ kind: 'daily', timezone: 'UTC', time: '7:00' })).toEqual([
        expect.stringContaining('HH:mm'),
      ]);
      expect(issues({ kind: 'daily', timezone: 'UTC', time: '24:00' })).toHaveLength(1);
      expect(issues({ kind: 'interval', timezone: 'UTC', everyMinutes: 45 })).toEqual([
        expect.stringContaining('divide the hour or the day'),
      ]);
      expect(
        issues({ kind: 'weekly', timezone: 'UTC', time: '07:00', daysOfWeek: [] }),
      ).toHaveLength(1);
      expect(
        issues({ kind: 'weekly', timezone: 'UTC', time: '07:00', daysOfWeek: [1, 1] }),
      ).toEqual(['Days must not repeat']);
      expect(
        issues({ kind: 'weekly', timezone: 'UTC', time: '07:00', daysOfWeek: [0] }),
      ).toHaveLength(1);
      expect(
        issues({ kind: 'monthly', timezone: 'UTC', time: '07:00', dayOfMonth: 32 }),
      ).toHaveLength(1);
      expect(issues({ kind: 'yearly', timezone: 'UTC' })).toHaveLength(1);
      // Strict: no unknown keys (e.g. a smuggled seconds field).
      expect(issues({ kind: 'daily', timezone: 'UTC', time: '07:00', seconds: 5 })).toHaveLength(1);
      expect(
        schema.safeParse({ schedule: { kind: 'daily', timezone: 'UTC', time: '07:00' }, x: 1 })
          .success,
      ).toBe(false);
    });

    it('accepts only standard 5-field cron expressions that run', () => {
      expect(issues({ kind: 'cron', timezone: 'UTC', expression: '0 0 7 * * *' })).toEqual([
        expect.stringContaining('5-field'),
      ]);
      expect(issues({ kind: 'cron', timezone: 'UTC', expression: '0 7 * *' })).toEqual([
        expect.stringContaining('5-field'),
      ]);
      expect(issues({ kind: 'cron', timezone: 'UTC', expression: '0 25 * * *' })).toEqual([
        expect.stringContaining('Invalid cron expression'),
      ]);
      expect(issues({ kind: 'cron', timezone: 'UTC', expression: '0 0 30 2 *' })).toEqual([
        'This schedule never runs',
      ]);
    });

    it('enforces the server minimum interval (default 5 minutes)', () => {
      expect(issues({ kind: 'interval', timezone: 'UTC', everyMinutes: 1 })).toEqual([
        'Schedules on this server run at most every 5 minutes',
      ]);
      expect(issues({ kind: 'cron', timezone: 'UTC', expression: '* * * * *' })).toHaveLength(1);
      expect(issues({ kind: 'cron', timezone: 'UTC', expression: '0,2 * * * *' })).toHaveLength(1);
      expect(issues({ kind: 'interval', timezone: 'UTC', everyMinutes: 5 })).toEqual([]);
      // An operator may allow every minute.
      const permissive = scheduleConfigSchema(1, () => NOW);
      expect(
        issues({ kind: 'cron', timezone: 'UTC', expression: '* * * * *' }, permissive),
      ).toEqual([]);
    });
  });

  describe('next occurrences in the timezone (AC-23.1)', () => {
    it('daily in Africa/Johannesburg (UTC+2, no DST)', () => {
      expect(
        next(
          { kind: 'daily', timezone: 'Africa/Johannesburg', time: '07:00' },
          '2026-03-07T12:00:00Z',
        ),
      ).toEqual([
        '2026-03-08T05:00:00.000Z',
        '2026-03-09T05:00:00.000Z',
        '2026-03-10T05:00:00.000Z',
      ]);
    });

    it('weekdays skip the weekend; weekly maps ISO Sunday (7)', () => {
      // 2026-10-02 is a Friday.
      expect(
        next({ kind: 'weekdays', timezone: 'UTC', time: '07:00' }, '2026-10-02T08:00:00Z', 2),
      ).toEqual(['2026-10-05T07:00:00.000Z', '2026-10-06T07:00:00.000Z']);
      expect(
        next(
          { kind: 'weekly', timezone: 'UTC', time: '09:00', daysOfWeek: [7] },
          '2026-10-01T00:00:00Z',
          2,
        ),
      ).toEqual(['2026-10-04T09:00:00.000Z', '2026-10-11T09:00:00.000Z']);
    });

    it('monthly "last" follows month length; day 31 skips short months', () => {
      expect(
        next(
          { kind: 'monthly', timezone: 'UTC', time: '09:00', dayOfMonth: 'last' },
          '2026-01-30T00:00:00Z',
        ),
      ).toEqual([
        '2026-01-31T09:00:00.000Z',
        '2026-02-28T09:00:00.000Z',
        '2026-03-31T09:00:00.000Z',
      ]);
      expect(
        next(
          { kind: 'monthly', timezone: 'UTC', time: '09:00', dayOfMonth: 31 },
          '2026-01-30T00:00:00Z',
        ),
      ).toEqual([
        '2026-01-31T09:00:00.000Z',
        '2026-03-31T09:00:00.000Z',
        '2026-05-31T09:00:00.000Z',
      ]);
    });

    it('interval schedules align to the hour in the timezone', () => {
      expect(
        next(
          { kind: 'interval', timezone: 'Asia/Kolkata', everyMinutes: 30 },
          '2026-10-03T10:07:00Z',
        ),
      ).toEqual([
        '2026-10-03T10:30:00.000Z',
        '2026-10-03T11:00:00.000Z',
        '2026-10-03T11:30:00.000Z',
      ]);
    });

    it('is strictly after the given instant', () => {
      const compiled = compileSchedule({ kind: 'daily', timezone: 'UTC', time: '07:00' });
      expect(nextOccurrence(compiled, new Date('2026-10-03T07:00:00.000Z'))?.toISOString()).toBe(
        '2026-10-04T07:00:00.000Z',
      );
    });
  });

  describe('DST (FR-23.8)', () => {
    it('America/New_York spring forward: a missing 02:30 runs once, shifted to 03:30 EDT', () => {
      expect(
        next(
          { kind: 'daily', timezone: 'America/New_York', time: '02:30' },
          '2026-03-07T12:00:00Z',
        ),
      ).toEqual([
        '2026-03-08T07:30:00.000Z', // 03:30 EDT (02:30 does not exist)
        '2026-03-09T06:30:00.000Z', // 02:30 EDT
        '2026-03-10T06:30:00.000Z',
      ]);
    });

    it('America/New_York fall back: a repeated 01:30 runs once (first occurrence)', () => {
      expect(
        next(
          { kind: 'daily', timezone: 'America/New_York', time: '01:30' },
          '2026-10-31T12:00:00Z',
        ),
      ).toEqual([
        '2026-11-01T05:30:00.000Z', // 01:30 EDT; the 01:30 EST an hour later does not run
        '2026-11-02T06:30:00.000Z',
        '2026-11-03T06:30:00.000Z',
      ]);
    });

    it('hourly across spring forward never repeats an instant', () => {
      expect(
        next(
          { kind: 'hourly', timezone: 'America/New_York', minute: 0 },
          '2026-03-08T05:30:00Z',
          3,
        ),
      ).toEqual([
        '2026-03-08T06:00:00.000Z',
        '2026-03-08T07:00:00.000Z',
        '2026-03-08T08:00:00.000Z',
      ]);
    });

    it('Europe/London spring forward and fall back', () => {
      expect(
        next(
          { kind: 'daily', timezone: 'Europe/London', time: '01:30' },
          '2026-03-28T12:00:00Z',
          2,
        ),
      ).toEqual([
        '2026-03-29T01:30:00.000Z', // 02:30 BST (01:30 does not exist)
        '2026-03-30T00:30:00.000Z',
      ]);
      expect(
        next(
          { kind: 'daily', timezone: 'Europe/London', time: '01:30' },
          '2026-10-24T12:00:00Z',
          2,
        ),
      ).toEqual([
        '2026-10-25T00:30:00.000Z', // 01:30 BST, once
        '2026-10-26T01:30:00.000Z',
      ]);
    });
  });

  describe('misfire policy (FR-23.7)', () => {
    const every5 = compileSchedule({ kind: 'interval', timezone: 'UTC', everyMinutes: 5 });
    const HOUR = 3_600_000;

    it('on time: fires the due occurrence, skips nothing', () => {
      const r = dueOccurrence(
        every5,
        new Date('2026-10-03T10:00:00Z'),
        new Date('2026-10-03T10:00:20Z'),
        HOUR,
      );
      expect(r.fire?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
      expect(r).toMatchObject({ skipped: 0, skippedBeforeWindow: false });
      expect(r.next?.toISOString()).toBe('2026-10-03T10:05:00.000Z');
    });

    it('after downtime within the grace window: fires only the latest, skips the rest', () => {
      const r = dueOccurrence(
        every5,
        new Date('2026-10-03T10:00:00Z'),
        new Date('2026-10-03T10:22:00Z'),
        HOUR,
      );
      expect(r.fire?.toISOString()).toBe('2026-10-03T10:20:00.000Z');
      expect(r).toMatchObject({ skipped: 4, skippedBeforeWindow: false });
      expect(r.next?.toISOString()).toBe('2026-10-03T10:25:00.000Z');
    });

    it('after long downtime: older occurrences are skipped without being enumerated', () => {
      const r = dueOccurrence(
        every5,
        new Date('2026-09-01T00:00:00Z'),
        new Date('2026-10-03T10:02:00Z'),
        HOUR,
      );
      expect(r.fire?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
      expect(r.skippedBeforeWindow).toBe(true);
    });

    it('nothing within the grace window: nothing fires', () => {
      const daily = compileSchedule({ kind: 'daily', timezone: 'UTC', time: '07:00' });
      const r = dueOccurrence(
        daily,
        new Date('2026-10-03T07:00:00Z'),
        new Date('2026-10-03T09:00:00Z'),
        HOUR,
      );
      expect(r.fire).toBeNull();
      expect(r.skippedBeforeWindow).toBe(true);
      expect(r.next?.toISOString()).toBe('2026-10-04T07:00:00.000Z');
    });
  });

  it('describes schedules for people', () => {
    expect(
      describeSchedule({ kind: 'weekdays', timezone: 'Africa/Johannesburg', time: '07:00' }),
    ).toBe('Weekdays at 07:00 (Africa/Johannesburg)');
    expect(
      describeSchedule({ kind: 'weekly', timezone: 'UTC', time: '16:00', daysOfWeek: [5, 1] }),
    ).toBe('Weekly on Mon, Fri at 16:00 (UTC)');
    expect(
      describeSchedule({ kind: 'monthly', timezone: 'UTC', time: '09:00', dayOfMonth: 'last' }),
    ).toBe('Monthly on the last day at 09:00 (UTC)');
    expect(describeSchedule({ kind: 'hourly', timezone: 'UTC', minute: 5 })).toBe(
      'Hourly at :05 (UTC)',
    );
    expect(describeSchedule({ kind: 'interval', timezone: 'UTC', everyMinutes: 15 })).toBe(
      'Every 15 minutes (UTC)',
    );
  });

  it('node type exposes the schedule; the handler passes the system trigger input through', async () => {
    const type = scheduleNodeType(5);
    const config = { schedule: { kind: 'daily', timezone: 'UTC', time: '07:00' } };
    expect(type).toMatchObject({ type: 'schedule.trigger', kind: 'TRIGGER' });
    expect(type.configSchema.safeParse(config).success).toBe(true);
    expect(type.schedule?.(config)).toEqual(config.schedule);
    const input = { triggerType: 'SCHEDULE', scheduledFor: '2026-10-03T07:00:00.000Z' };
    await expect(scheduleTriggerHandler.execute({ triggerInput: input } as never)).resolves.toEqual(
      { output: input },
    );
    expect(scheduleTriggerHandler.sideEffect).toBe('none');
  });
});
