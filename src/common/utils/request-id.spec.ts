import { resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('reuses a well-formed incoming id', () => {
    expect(resolveRequestId('abc-123_x.y')).toBe('abc-123_x.y');
  });

  it('uses the first value of a repeated header', () => {
    expect(resolveRequestId(['first', 'second'])).toBe('first');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
    ['newline (log injection)', 'abc\n{"level":"fatal"}'],
    ['spaces', 'abc def'],
  ])('generates a new uuid when the incoming id is %s', (_label, incoming) => {
    expect(resolveRequestId(incoming)).toMatch(UUID);
  });
});
