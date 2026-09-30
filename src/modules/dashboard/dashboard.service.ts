import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class DashboardService {
  summary(_workspaceId: string): Promise<unknown> {
    throw new NotImplementedException();
  }
}
