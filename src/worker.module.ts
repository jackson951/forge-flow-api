import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { ExecutionModule } from './execution/execution.module';

/**
 * Background worker process: consumes the run queue and executes workflows.
 * Integration and AI modules join here as their handlers are implemented (Parts 10–14).
 */
@Module({
  imports: [CoreModule, ExecutionModule],
})
export class WorkerModule {}
