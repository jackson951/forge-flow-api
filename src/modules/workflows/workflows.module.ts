import { ProviderSyncRequester } from './provider-sync.service';
import { HooksModule } from '../hooks/hooks.module';
import { Module } from '@nestjs/common';
import { EngineModule } from '../../engine/engine.module';
import { NodeTypesController } from './node-types.controller';
import { WorkflowsController } from './workflows.controller';
import { PublishingService } from './publishing.service';
import { TriggerRoutingService } from './trigger-routing.service';
import { WorkflowsService } from './workflows.service';

@Module({
  imports: [EngineModule, HooksModule],
  controllers: [WorkflowsController, NodeTypesController],
  providers: [WorkflowsService, PublishingService, TriggerRoutingService, ProviderSyncRequester],
  exports: [WorkflowsService, PublishingService],
})
export class WorkflowsModule {}
