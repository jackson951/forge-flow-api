import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { EngineModule } from './engine/engine.module';
import { WorkflowRunProcessor } from './engine/processors/workflow-run.processor';
import { AiModule } from './modules/ai/ai.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';

/** Background worker process: consumes the run queue and executes workflows. */
@Module({
  imports: [CoreModule, EngineModule, IntegrationsModule, AiModule],
  providers: [WorkflowRunProcessor],
})
export class WorkerModule {}
