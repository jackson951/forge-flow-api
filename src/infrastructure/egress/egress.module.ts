import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { EgressClient } from './egress-client';

/**
 * The guarded HTTP client for user-chosen destinations (Part 24), one per process. Used by
 * the worker (http.request) and by the API only for connection tests.
 */
@Global()
@Module({
  providers: [
    {
      provide: EgressClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => new EgressClient(config.http.policy),
    },
  ],
  exports: [EgressClient],
})
export class EgressModule {}
