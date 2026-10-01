import { Module } from '@nestjs/common';
import { EngineModule } from '../../engine/engine.module';
import { NodeTypesController } from './node-types.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

@Module({
  imports: [EngineModule],
  controllers: [WorkflowsController, NodeTypesController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
