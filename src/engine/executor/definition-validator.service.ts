import { Injectable, NotImplementedException } from '@nestjs/common';
import { WorkflowDefinition } from '../contracts';

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

/** Validates a definition before publish: one trigger, connected path, valid node configs. */
@Injectable()
export class DefinitionValidatorService {
  validate(_definition: WorkflowDefinition): ValidationIssue[] {
    throw new NotImplementedException();
  }
}
