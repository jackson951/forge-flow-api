import { Injectable, NotImplementedException } from '@nestjs/common';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';

@Injectable()
export class WorkflowsService {
  list(_workspaceId: string, _query: PaginationQueryDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  get(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  create(_workspaceId: string, _dto: CreateWorkflowDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  update(_workspaceId: string, _id: string, _dto: UpdateWorkflowDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  saveDraft(_workspaceId: string, _id: string, _dto: SaveDraftDto): Promise<unknown> {
    throw new NotImplementedException();
  }

  validate(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  publish(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  duplicate(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  archive(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }

  remove(_workspaceId: string, _id: string): Promise<void> {
    throw new NotImplementedException();
  }

  listVersions(_workspaceId: string, _id: string): Promise<unknown> {
    throw new NotImplementedException();
  }
}
