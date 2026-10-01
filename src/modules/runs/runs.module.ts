import { Module } from '@nestjs/common';
import { RunDispatcherService } from './run-dispatcher.service';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { WorkflowRunsController } from './workflow-runs.controller';

@Module({
  controllers: [RunsController, WorkflowRunsController],
  providers: [RunsService, RunDispatcherService],
  exports: [RunsService, RunDispatcherService],
})
export class RunsModule {}
