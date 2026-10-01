import { Module } from '@nestjs/common';
import { EngineModule } from '../../engine/engine.module';
import { NodeTypesController } from './node-types.controller';
import { WorkflowsController } from './workflows.controller';
import { PublishingService } from './publishing.service';
import { TriggerRoutingService } from './trigger-routing.service';
import { WorkflowsService } from './workflows.service';

@Module({
  imports: [EngineModule],
  controllers: [WorkflowsController, NodeTypesController],
  providers: [WorkflowsService, PublishingService, TriggerRoutingService],
  exports: [WorkflowsService, PublishingService],
})
export class WorkflowsModule {}
