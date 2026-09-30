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
import { CurrentUser } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
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
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.workflows.list(user.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(user.workspaceId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(user.workspaceId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.workflows.update(user.workspaceId, id, dto);
  }

  @Put(':id/draft')
  saveDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveDraftDto,
  ) {
    return this.workflows.saveDraft(user.workspaceId, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/validate')
  validate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.validate(user.workspaceId, id);
  }

  @Post(':id/publish')
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.publish(user.workspaceId, id);
  }

  @Get(':id/versions')
  versions(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.listVersions(user.workspaceId, id);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.duplicate(user.workspaceId, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/archive')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.archive(user.workspaceId, id);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(user.workspaceId, id);
  }
}
