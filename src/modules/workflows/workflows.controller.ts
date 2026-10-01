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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { pendingWorkspaceScope } from '../../common/utils/pending-workspace-scope';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowsService } from './workflows.service';

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@Query() query: PaginationQueryDto) {
    return this.workflows.list(pendingWorkspaceScope(), query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(pendingWorkspaceScope(), id);
  }

  @Post()
  create(@Body() dto: CreateWorkflowDto) {
    return this.workflows.create(pendingWorkspaceScope(), dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkflowDto) {
    return this.workflows.update(pendingWorkspaceScope(), id, dto);
  }

  @Put(':id/draft')
  saveDraft(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveDraftDto) {
    return this.workflows.saveDraft(pendingWorkspaceScope(), id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/validate')
  validate(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.validate(pendingWorkspaceScope(), id);
  }

  @Post(':id/publish')
  publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.publish(pendingWorkspaceScope(), id);
  }

  @Get(':id/versions')
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.listVersions(pendingWorkspaceScope(), id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.duplicate(pendingWorkspaceScope(), id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/archive')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.archive(pendingWorkspaceScope(), id);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(pendingWorkspaceScope(), id);
  }
}
