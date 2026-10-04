import { Module } from '@nestjs/common';
import { HookAdminService } from './hook-admin.service';
import { HookIntakeService } from './hook-intake.service';
import { HookProvisioner } from './hook-provisioner.service';
import { HooksController } from './hooks.controller';
import { WorkflowWebhookController } from './workflow-webhook.controller';

/** Generic inbound webhooks (Part 24). */
@Module({
  controllers: [HooksController, WorkflowWebhookController],
  providers: [HookProvisioner, HookIntakeService, HookAdminService],
  exports: [HookProvisioner],
})
export class HooksModule {}
