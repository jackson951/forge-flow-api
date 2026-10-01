import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentWorkspace, RequireRole } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowsService } from './workflows.service';

/** Roles follow the Part 04 matrix; the handlers themselves arrive in Parts 05–06. */
@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceAccess, @Query() query: PaginationQueryDto) {
    return this.workflows.list(ws.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(ws.workspaceId, id);
  }

  @Post()
  create(@CurrentWorkspace() ws: WorkspaceAccess, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(ws.workspaceId, dto);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.workflows.update(ws.workspaceId, id, dto);
  }

  @Put(':id/draft')
  saveDraft(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveDraftDto,
  ) {
    return this.workflows.saveDraft(ws.workspaceId, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/validate')
  validate(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.validate(ws.workspaceId, id);
  }

  @RequireRole('ADMIN')
  @Post(':id/publish')
  publish(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.publish(ws.workspaceId, id);
  }

  @Get(':id/versions')
  versions(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.listVersions(ws.workspaceId, id);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.duplicate(ws.workspaceId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/archive')
  archive(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.archive(ws.workspaceId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(ws.workspaceId, id);
  }
}
