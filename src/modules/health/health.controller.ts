import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiResponse, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators';
import { HealthService, ReadinessReport } from './health.service';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness — the process is up. Does not touch dependencies. */
  @Get()
  @ApiOperation({ summary: 'Liveness: the process is up (does not touch dependencies)' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Readiness — PostgreSQL and Redis are reachable. */
  @Get('ready')
  @ApiResponse({ status: HttpStatus.OK, description: 'All critical dependencies are up' })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: 'A dependency is down' })
  @ApiOperation({ summary: 'Readiness: PostgreSQL and Redis are reachable (503 otherwise)' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
