import { parseDurationMs } from './duration';

describe('parseDurationMs', () => {
  it.each([
    ['900s', 900_000],
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['7d', 604_800_000],
  ])('%s → %d ms', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(['15', '1w', '-1m', '1.5h', ''])('rejects %p', (input) => {
    expect(() => parseDurationMs(input)).toThrow(/Invalid duration/);
  });
});
