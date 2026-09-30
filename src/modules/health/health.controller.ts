import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { HealthService } from './health.service';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness — the process is up. */
  @Get()
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Readiness — dependencies (Postgres, Redis) are reachable. */
  @Get('ready')
  ready() {
    return this.health.readiness();
  }
}
