import { Injectable } from '@nestjs/common';
import { NodeTypeCatalog } from '../catalog/node-type-catalog';
import { parseDefinition, ParseResult, WorkflowDefinition } from '../definition/definition.schema';
import { validateDefinition, ValidationIssue } from '../validation/graph-validator';

/** Nest wrapper around the pure parser/validator, bound to the app's node type catalog. */
@Injectable()
export class DefinitionValidatorService {
  constructor(private readonly catalog: NodeTypeCatalog) {}

  parse(raw: unknown): ParseResult {
    return parseDefinition(raw);
  }

  validate(definition: WorkflowDefinition): ValidationIssue[] {
    return validateDefinition(definition, this.catalog);
  }
}
