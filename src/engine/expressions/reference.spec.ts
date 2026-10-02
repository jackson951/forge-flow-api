import { MISSING, parseReference, ReferenceSyntaxError, resolveReference } from './reference';

describe('parseReference', () => {
  it.each([
    ['trigger', { root: 'trigger', path: [] }],
    ['trigger.issue.title', { root: 'trigger', path: ['issue', 'title'] }],
    ['trigger.issue.labels.0.name', { root: 'trigger', path: ['issue', 'labels', 0, 'name'] }],
    ['steps.classify.output', { root: 'steps', nodeKey: 'classify', path: [] }],
    ['steps.ai_1.output.priority', { root: 'steps', nodeKey: 'ai_1', path: ['priority'] }],
  ])('parses %s', (text, expected) => {
    expect(parseReference(text)).toMatchObject(expected);
  });

  it.each([
    ['', 'empty'],
    ['issue.title', 'must start with'],
    ['steps.classify.priority', '".output"'],
    ['steps..output', 'expected steps.<nodeKey>.output'],
    ['steps.1bad.output', 'expected steps.<nodeKey>.output'],
    ['trigger.__proto__.polluted', '"__proto__" is not allowed'],
    ['trigger.constructor.prototype', '"constructor" is not allowed'],
    ['steps.a.output.prototype', '"prototype" is not allowed'],
    ['trigger.a-b', 'invalid segment'],
    ['trigger.a b', 'invalid segment'],
    ['trigger.a[0]', 'invalid segment'],
    ['trigger.a()', 'invalid segment'],
    ['trigger.x;process.exit()', 'invalid segment'],
    ['trigger.' + 'a.'.repeat(25) + 'a', 'too many segments'],
    ['trigger.' + 'a'.repeat(400), 'too long'],
  ])('rejects %p (%s)', (text, reason) => {
    expect(() => parseReference(text)).toThrow(ReferenceSyntaxError);
    expect(() => parseReference(text)).toThrow(reason);
  });
});

describe('resolveReference', () => {
  const scope = {
    trigger: { issue: { title: 'Crash', labels: [{ name: 'bug' }], body: null, empty: '' } },
    outputs: { classify: { priority: 'HIGH', score: 0.9 }, trigger: { issue: { title: 'Crash' } } },
  };
  const resolve = (text: string) => resolveReference(parseReference(text), scope);

  it('resolves nested objects, arrays and step outputs', () => {
    expect(resolve('trigger.issue.title')).toBe('Crash');
    expect(resolve('trigger.issue.labels.0.name')).toBe('bug');
    expect(resolve('steps.classify.output.priority')).toBe('HIGH');
    expect(resolve('steps.classify.output')).toEqual({ priority: 'HIGH', score: 0.9 });
  });

  it('distinguishes null and empty from missing', () => {
    expect(resolve('trigger.issue.body')).toBeNull();
    expect(resolve('trigger.issue.empty')).toBe('');
    expect(resolve('trigger.issue.nope')).toBe(MISSING);
    expect(resolve('trigger.issue.labels.5.name')).toBe(MISSING);
    expect(resolve('trigger.issue.title.length')).toBe(MISSING); // no properties of primitives
    expect(resolve('steps.unknown.output.x')).toBe(MISSING);
  });

  it('never reads through the prototype chain', () => {
    const inherited = Object.create({ secret: 'from prototype' }) as Record<string, unknown>;
    const s = { trigger: inherited, outputs: {} };
    expect(resolveReference(parseReference('trigger.secret'), s)).toBe(MISSING);
    expect(resolveReference(parseReference('trigger.toString'), s)).toBe(MISSING);
    expect(resolveReference(parseReference('trigger.hasOwnProperty'), scope)).toBe(MISSING);
  });

  it('array indexes only apply to arrays, names only to objects', () => {
    expect(
      resolveReference(parseReference('trigger.0'), { trigger: { 0: 'x' }, outputs: {} }),
    ).toBe(MISSING);
    expect(
      resolveReference(parseReference('trigger.length'), { trigger: [1, 2], outputs: {} }),
    ).toBe(MISSING);
  });
});
