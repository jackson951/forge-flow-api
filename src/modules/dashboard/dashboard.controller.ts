import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { CurrentWorkspace } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Run counts, top failing workflows and recent failures' })
  summary(@CurrentWorkspace() ws: WorkspaceAccess) {
    return this.dashboard.summary(ws.workspaceId);
  }
}
