import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  async readiness(): Promise<{ status: string; checks: Record<string, string> }> {
    // TODO: ping Postgres (SELECT 1) and Redis
    return { status: 'unknown', checks: { database: 'unchecked', redis: 'unchecked' } };
  }
}
