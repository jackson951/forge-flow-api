import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { CurrentWorkspace, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { ListVersionsQueryDto } from './dto/list-versions-query.dto';
import { ListWorkflowsQueryDto } from './dto/list-workflows-query.dto';
import { PublishWorkflowDto } from './dto/publish-workflow.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { ValidateDefinitionDto } from './dto/validate-definition.dto';
import { PublishingService } from './publishing.service';
import { WorkflowsService } from './workflows.service';

/** Roles follow the Part 04 matrix: members author, ADMIN+ change what runs. */
@ApiTags('Workflows')
@ApiBearerAuth()
@ApiNotFoundResponse({ description: 'Workspace or workflow not found (or not a member)' })
@Controller('workspaces/:workspaceId/workflows')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly publishing: PublishingService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Workflows of the workspace (keyset-paginated, archived hidden by default)',
  })
  list(@CurrentWorkspace() ws: WorkspaceAccess, @Query() query: ListWorkflowsQueryDto) {
    return this.workflows.list(ws.workspaceId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One workflow with its current draft' })
  get(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(ws.workspaceId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a workflow with an empty draft' })
  create(@CurrentWorkspace() ws: WorkspaceAccess, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(ws.workspaceId, ws.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or describe a workflow' })
  update(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.workflows.update(ws.workspaceId, id, dto);
  }

  @ApiBadRequestResponse({ description: 'Malformed definition or size limit exceeded' })
  @ApiConflictResponse({ description: 'Stale expectedRevision, or workflow archived' })
  @Put(':id/draft')
  @ApiOperation({
    summary:
      'Save the draft (optimistic concurrency via expectedRevision); returns validation issues',
  })
  saveDraft(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveDraftDto,
  ) {
    return this.workflows.saveDraft(ws.workspaceId, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/validate')
  @ApiOperation({ summary: 'Validate the draft without saving' })
  validate(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ValidateDefinitionDto,
  ) {
    return this.workflows.validate(ws.workspaceId, id, dto.definition);
  }

  /** Freezes the reviewed draft as the next immutable version and activates it. */
  @RequireRole('ADMIN')
  @ApiUnprocessableEntityResponse({ description: 'The draft has validation errors' })
  @ApiConflictResponse({ description: 'Stale revision, archived, or nothing changed' })
  @Post(':id/publish')
  @ApiOperation({
    summary: 'Publish the reviewed draft as the next immutable version and activate it (ADMIN)',
  })
  publish(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishWorkflowDto,
  ) {
    return this.publishing.publish(ws.workspaceId, ws.userId, id, dto.expectedRevision);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Published versions, newest first (keyset-paginated)' })
  versions(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListVersionsQueryDto,
  ) {
    return this.publishing.listVersions(ws.workspaceId, id, query.limit, query.cursor);
  }

  /** Versions are read-only: there is deliberately no update or delete route. */
  @Get(':id/versions/:version')
  @ApiOperation({ summary: 'One published version (read-only)' })
  version(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.publishing.getVersion(ws.workspaceId, id, version);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Copy a workflow as a new draft' })
  duplicate(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.duplicate(ws.workspaceId, ws.userId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive (ADMIN): stops triggers; history is kept' })
  archive(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.archive(ws.workspaceId, ws.userId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/unarchive')
  @ApiOperation({
    summary:
      'Unarchive (ADMIN): back to PUBLISHED with its active version, or DRAFT if never published',
  })
  unarchive(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.unarchive(ws.workspaceId, ws.userId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiConflictResponse({ description: 'Workflow has run history; archive it instead' })
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a workflow that has never run (ADMIN; otherwise archive it)' })
  remove(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(ws.workspaceId, ws.userId, id);
  }
}
