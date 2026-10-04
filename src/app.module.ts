import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { WorkspaceAccessGuard } from './common/guards/workspace-access.guard';
import { createValidationPipe } from './common/pipes/validation.pipe';
import { AppConfigService } from './config/app-config.service';
import { byIp, byUserOrIp, MINUTE, RATE_LIMITS } from './common/throttling/rate-limits';
import { CoreModule } from './core/core.module';
import { REDIS_CLIENT } from './infrastructure/redis/redis.module';
import { RedisThrottlerStorage } from './infrastructure/throttling/redis-throttler.storage';
import Redis from 'ioredis';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { RunsModule } from './modules/runs/runs.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { HooksModule } from './modules/hooks/hooks.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';

/** HTTP API process. Never executes workflows inline — it only enqueues. */
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, REDIS_CLIENT],
      useFactory: (config: AppConfigService, redis: Redis) => ({
        throttlers: [
          {
            name: 'default',
            ttl: MINUTE,
            limit: RATE_LIMITS.authenticatedPerUser,
            getTracker: byUserOrIp,
          },
          { name: 'ip', ttl: MINUTE, limit: RATE_LIMITS.perIpFloodCap, getTracker: byIp },
        ],
        // Shared by all API instances (Part 18).
        storage: new RedisThrottlerStorage(redis, config),
        skipIf: () => !config.throttleEnabled,
      }),
    }),
    AuditModule,
    HealthModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    WorkflowsModule,
    RunsModule,
    IntegrationsModule,
    WebhooksModule,
    HooksModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    // After authentication, so limits can be counted per user; public routes are still
    // limited (per IP / per IP+email).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Runs after AuthGuard: checks membership/role on every route with a :workspaceId param.
    { provide: APP_GUARD, useClass: WorkspaceAccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      provide: APP_PIPE,
      useValue: createValidationPipe(),
    },
  ],
})
export class AppModule {}
