import { Injectable, NotImplementedException } from '@nestjs/common';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';

/** Run history, retry and cancel arrive in Part 16. */
@Injectable()
export class RunsService {
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
