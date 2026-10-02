import { PinoLogger } from 'nestjs-pino';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Records every structured log call made through PinoLogger (API and in-process workers)
 * while still logging normally. Call in `beforeAll`, before the apps are created; spies are
 * removed by `jest.restoreAllMocks()`.
 */
export function captureLogs(calls: unknown[][] = []): unknown[][] {
  for (const level of LEVELS) {
    const original = PinoLogger.prototype[level];
    jest.spyOn(PinoLogger.prototype, level).mockImplementation(function (
      this: PinoLogger,
      ...args: unknown[]
    ) {
      calls.push(args);
      return (original as (...a: unknown[]) => void).apply(this, args);
    });
  }
  return calls;
}

/** Asserts that none of the canary secrets appears anywhere in the given values. */
export function expectNoSecrets(haystacks: unknown[], secrets: string[]): void {
  const text = haystacks.map((h) => (typeof h === 'string' ? h : JSON.stringify(h))).join('\n');
  const leaked = secrets.filter((s) => s && text.includes(s));
  expect(leaked).toEqual([]);
}
