import { Module } from '@nestjs/common';
import { NodeTypeCatalog } from './catalog/node-type-catalog';
import { ConditionEvaluatorService } from './conditions/condition-evaluator.service';
import { DefinitionValidatorService } from './executor/definition-validator.service';

/**
 * Definition-level engine services used by both API (validation) and worker. Execution
 * itself lives in the worker-only ExecutionModule.
 */
@Module({
  providers: [
    // One catalog per application (a factory, not a shared instance), so registrations in
    // one app or test never leak into another.
    { provide: NodeTypeCatalog, useFactory: () => new NodeTypeCatalog() },
    DefinitionValidatorService,
    ConditionEvaluatorService,
  ],
  exports: [NodeTypeCatalog, DefinitionValidatorService, ConditionEvaluatorService],
})
export class EngineModule {}
