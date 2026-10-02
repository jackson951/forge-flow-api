import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

@Global()
@Module({
  // skipProcessEnv: values come only from the validated schema. Otherwise a variable that
  // validation turned into "unset" (e.g. `PROVIDER_CONCURRENCY=`) falls back to the raw ''.
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      skipProcessEnv: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
