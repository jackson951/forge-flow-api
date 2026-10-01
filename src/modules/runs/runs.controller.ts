import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentWorkspace, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';
import { RunsService } from './runs.service';

/** Handlers arrive in Part 16; roles follow the Part 04 matrix. */
@ApiTags('Runs')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceAccess, @Query() query: ListRunsQueryDto) {
    return this.runs.list(ws.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(ws.workspaceId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/retry')
  retry(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.retry(ws.workspaceId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.cancel(ws.workspaceId, id);
  }
}
