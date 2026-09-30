import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ExecuteRunJobData, QUEUES } from '../../infrastructure/queue/queue.constants';
import { WorkflowExecutorService } from '../executor/workflow-executor.service';

/** Consumes queued runs. Registered only in the worker process. */
@Processor(QUEUES.WORKFLOW_RUNS)
export class WorkflowRunProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkflowRunProcessor.name);

  constructor(private readonly executor: WorkflowExecutorService) {
    super();
  }

  async process(job: Job<ExecuteRunJobData>): Promise<void> {
    this.logger.log(`Processing run ${job.data.runId} (job ${job.id})`);
    await this.executor.execute(job.data.runId);
  }
}
