import { collectReferences, mapConfig, MappingError, renderTemplate } from './mapping';
import { ReferenceSyntaxError } from './reference';

const scope = {
  trigger: { issue: { title: 'Crash on login', number: 42, labels: ['bug', 'p1'], body: null } },
  outputs: { classify: { priority: 'HIGH', tags: { area: 'auth' } } },
};

describe('renderTemplate', () => {
  it('replaces placeholders, tolerating whitespace', () => {
    expect(renderTemplate('#{{trigger.issue.number}}: {{ trigger.issue.title }}', scope)).toBe(
      '#42: Crash on login',
    );
  });

  it('JSON-encodes objects and arrays', () => {
    expect(
      renderTemplate('{{ trigger.issue.labels }} {{ steps.classify.output.tags }}', scope),
    ).toBe('["bug","p1"] {"area":"auth"}');
  });

  it('renders missing and null as empty, reporting only missing', () => {
    const missing: string[] = [];
    expect(renderTemplate('[{{ trigger.issue.body }}][{{ trigger.nope }}]', scope, missing)).toBe(
      '[][]',
    );
    expect(missing).toEqual(['trigger.nope']);
  });

  it('is single-pass: resolved data is never treated as a template', () => {
    const tricky = { trigger: { text: '{{ trigger.secret }}', secret: 'leak' }, outputs: {} };
    expect(renderTemplate('{{ trigger.text }}', tricky)).toBe('{{ trigger.secret }}');
  });

  it('leaves text without placeholders alone', () => {
    expect(renderTemplate('no { braces } here', scope)).toBe('no { braces } here');
  });

  it('rejects invalid references inside templates', () => {
    expect(() => renderTemplate('{{ trigger.__proto__ }}', scope)).toThrow(ReferenceSyntaxError);
    expect(() => renderTemplate('{{ process.env.SECRET }}', scope)).toThrow(ReferenceSyntaxError);
  });

  it('caps the rendered length', () => {
    const big = { trigger: { blob: 'x'.repeat(17_000) }, outputs: {} };
    expect(() => renderTemplate('{{ trigger.blob }}', big)).toThrow(MappingError);
  });
});

describe('mapConfig', () => {
  it('maps templates and { ref } objects throughout the config, preserving types', () => {
    const { value, missing } = mapConfig(
      {
        text: 'Priority {{ steps.classify.output.priority }}',
        labels: { ref: 'trigger.issue.labels' },
        number: { ref: 'trigger.issue.number' },
        nested: [{ title: '{{ trigger.issue.title }}' }],
        absent: { ref: 'trigger.issue.assignee' },
        literal: 7,
        notARef: { ref: 'trigger.issue.title', extra: true },
      },
      scope,
    );
    expect(value).toEqual({
      text: 'Priority HIGH',
      labels: ['bug', 'p1'],
      number: 42,
      nested: [{ title: 'Crash on login' }],
      absent: null,
      literal: 7,
      notARef: { ref: 'trigger.issue.title', extra: true },
    });
    expect(missing).toEqual(['trigger.issue.assignee']);
  });
});

describe('collectReferences', () => {
  const config = {
    text: 'Hi {{ trigger.user }} {{steps.a.output.x}}',
    ref: { ref: 'steps.b.output' },
    list: [{ ref: 'trigger.y' }],
  };

  it('finds template and { ref } references', () => {
    expect(collectReferences(config).sort()).toEqual(
      ['steps.a.output.x', 'steps.b.output', 'trigger.user', 'trigger.y'].sort(),
    );
  });

  it('can ignore templates (condition literals)', () => {
    expect(collectReferences(config, { templates: false }).sort()).toEqual([
      'steps.b.output',
      'trigger.y',
    ]);
  });
});
