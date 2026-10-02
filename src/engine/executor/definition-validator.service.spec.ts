import { NodeTypeCatalog } from '../catalog/node-type-catalog';
import { DefinitionValidatorService } from './definition-validator.service';

describe('DefinitionValidatorService', () => {
  const service = new DefinitionValidatorService(new NodeTypeCatalog());

  it('parses and validates against the app catalog', () => {
    const parsed = service.parse({
      schemaVersion: 1,
      nodes: [
        { key: 'start', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
        { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'hi' } },
      ],
      edges: [{ from: 'start', to: 'log' }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(service.validate(parsed.definition)).toEqual([]);
  });

  it('reports unknown node types from the catalog', () => {
    const parsed = service.parse({
      schemaVersion: 1,
      nodes: [{ key: 'start', kind: 'TRIGGER', type: 'nope.trigger', config: {} }],
      edges: [],
    });
    expect(parsed.ok && service.validate(parsed.definition).map((i) => i.code)).toContain(
      'UNKNOWN_NODE_TYPE',
    );
  });

  it('rejects input that is not a definition', () => {
    expect(service.parse({ nodes: 'x' }).ok).toBe(false);
  });
});
