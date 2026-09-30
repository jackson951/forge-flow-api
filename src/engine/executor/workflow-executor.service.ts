import { Injectable, NotImplementedException } from '@nestjs/common';

/**
 * Resolves nodes in deterministic order, runs each step, persists
 * StepRun records and follows condition branches (scope §5.5).
 */
@Injectable()
export class WorkflowExecutorService {
  async execute(_runId: string): Promise<void> {
    throw new NotImplementedException();
  }
}
