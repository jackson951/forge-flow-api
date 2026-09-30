import { Module } from '@nestjs/common';
import { ConditionEvaluatorService } from './conditions/condition-evaluator.service';
import { DefinitionValidatorService } from './executor/definition-validator.service';
import { WorkflowExecutorService } from './executor/workflow-executor.service';
import { NodeRegistryService } from './registry/node-registry.service';

@Module({
  providers: [
    NodeRegistryService,
    WorkflowExecutorService,
    DefinitionValidatorService,
    ConditionEvaluatorService,
  ],
  exports: [
    NodeRegistryService,
    WorkflowExecutorService,
    DefinitionValidatorService,
    ConditionEvaluatorService,
  ],
})
export class EngineModule {}
