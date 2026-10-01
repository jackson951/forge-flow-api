import { WorkflowDefinition } from '../definition/definition.schema';
import { NodeTypeCatalog, TriggerRoute } from './node-type-catalog';

/**
 * Routing entries for a (validated) definition: one per webhook trigger. A definition whose
 * trigger is manual yields none.
 */
export function deriveTriggerRoutes(
  definition: WorkflowDefinition,
  catalog: NodeTypeCatalog,
): TriggerRoute[] {
  return definition.nodes
    .filter((node) => node.kind === 'TRIGGER')
    .flatMap((node) => {
      const route = catalog.get(node.type)?.route;
      return route ? [route(node.config)] : [];
    });
}
