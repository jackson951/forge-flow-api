import { Module } from '@nestjs/common';
import { NodeTypeCatalog } from './catalog/node-type-catalog';
import { ConditionEvaluatorService } from './conditions/condition-evaluator.service';
import { DefinitionValidatorService } from './executor/definition-validator.service';
import { WorkflowExecutorService } from './executor/workflow-executor.service';
import { NodeRegistryService } from './registry/node-registry.service';

@Module({
  providers: [
    { provide: NodeTypeCatalog, useValue: new NodeTypeCatalog() },
    NodeRegistryService,
    WorkflowExecutorService,
    DefinitionValidatorService,
    ConditionEvaluatorService,
  ],
  exports: [
    NodeTypeCatalog,
    NodeRegistryService,
    WorkflowExecutorService,
    DefinitionValidatorService,
    ConditionEvaluatorService,
  ],
})
export class EngineModule {}
