import { IsArray, IsObject } from 'class-validator';
import { EdgeDefinition, NodeDefinition, TriggerDefinition } from '../../../engine/contracts';

/** Draft definition from the builder. Deep node-config validation happens in the engine. */
export class SaveDraftDto {
  @IsObject()
  trigger: TriggerDefinition;

  @IsArray()
  nodes: NodeDefinition[];

  @IsArray()
  edges: EdgeDefinition[];
}
