import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class WorkspacesService {
  listForUser(_userId: string): Promise<unknown[]> {
    throw new NotImplementedException();
  }

  assertMembership(_userId: string, _workspaceId: string): Promise<void> {
    throw new NotImplementedException();
  }
}
