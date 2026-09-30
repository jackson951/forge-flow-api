import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotImplementedException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ExecuteRunJobData, QUEUES } from '../../infrastructure/queue/queue.constants';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';

@Injectable()
export class RunsService {
  constructor(
    @InjectQueue(QUEUES.WORKFLOW_RUNS)
    private readonly runsQueue: Queue<ExecuteRunJobData>,
  ) {}

  list(_workspaceId: string, _query: ListRunsQueryDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  get(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  retry(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  cancel(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }
}
