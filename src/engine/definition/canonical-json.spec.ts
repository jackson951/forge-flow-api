import { canonicalJson, definitionHash } from './canonical-json';

describe('canonicalJson / definitionHash', () => {
  it('ignores object key order at every depth', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const b = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(definitionHash(a)).toBe(definitionHash(b));
  });

  it('preserves array order', () => {
    expect(definitionHash([1, 2])).not.toBe(definitionHash([2, 1]));
  });

  it('distinguishes different values', () => {
    expect(definitionHash({ a: 1 })).not.toBe(definitionHash({ a: '1' }));
  });

  it('produces a sha256 hex digest', () => {
    expect(definitionHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
