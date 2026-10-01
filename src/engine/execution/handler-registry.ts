import { NodeTypeCatalog } from '../catalog/node-type-catalog';
import { NodeHandler } from './node-handler';

/** Maps node types to handlers. Validated against the catalog at worker startup. */
export class NodeHandlerRegistry {
  private readonly handlers = new Map<string, NodeHandler>();

  constructor(handlers: NodeHandler[] = []) {
    handlers.forEach((h) => this.register(h));
  }

  register(handler: NodeHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Handler for "${handler.type}" is already registered`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * Every publishable node type needs a handler of the same kind, otherwise published
   * workflows would fail at runtime. Returns problems instead of throwing so the caller
   * decides (the worker refuses to start).
   */
  verifyAgainst(catalog: NodeTypeCatalog): string[] {
    return catalog.list().flatMap((type) => {
      const handler = this.handlers.get(type.type);
      if (!handler) return [`No handler for node type "${type.type}"`];
      if (handler.kind !== type.kind) {
        return [`Handler for "${type.type}" is ${handler.kind}, catalog says ${type.kind}`];
      }
      return [];
    });
  }
}
