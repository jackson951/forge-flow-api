import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, CurrentWorkspace, RequireRole } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { CreateWorkspaceDto, UpdateWorkspaceDto, WorkspaceResponseDto } from './dto/workspace.dto';
import { WorkspacesService } from './workspaces.service';

@ApiTags('Workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @ApiCreatedResponse({ type: WorkspaceResponseDto })
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    return this.workspaces.create(user.userId, dto.name);
  }

  @ApiOkResponse({ type: [WorkspaceResponseDto] })
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<WorkspaceResponseDto[]> {
    return this.workspaces.listForUser(user.userId);
  }

  @ApiOkResponse({ type: WorkspaceResponseDto })
  @ApiNotFoundResponse({ description: 'Not a member (or no such workspace)' })
  @Get(':workspaceId')
  get(@CurrentWorkspace() access: WorkspaceAccess): Promise<WorkspaceResponseDto> {
    return this.workspaces.get(access);
  }

  @RequireRole('ADMIN')
  @ApiOkResponse({ type: WorkspaceResponseDto })
  @ApiForbiddenResponse()
  @Patch(':workspaceId')
  rename(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Body() dto: UpdateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    return this.workspaces.rename(access, dto.name);
  }

  @RequireRole('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiForbiddenResponse()
  @Delete(':workspaceId')
  delete(@CurrentWorkspace() access: WorkspaceAccess): Promise<void> {
    return this.workspaces.delete(access);
  }
}
