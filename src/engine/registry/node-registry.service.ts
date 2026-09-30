import { Injectable } from '@nestjs/common';
import { NodeHandler } from '../contracts';

/** Maps node type strings to their handler implementations. */
@Injectable()
export class NodeRegistryService {
  private readonly handlers = new Map<string, NodeHandler>();

  register(handler: NodeHandler): void {
    this.handlers.set(handler.type, handler);
  }

  get(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }
}
