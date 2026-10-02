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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiOperation,
} from '@nestjs/swagger';
import { CurrentWorkspace, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { AddMemberDto, MemberResponseDto, UpdateMemberRoleDto } from './dto/member.dto';
import { MembersService } from './members.service';

/**
 * Fine-grained rules (who may grant OWNER, last-owner protection, self-leave) live in
 * WorkspacePolicy/MembersService; the guard only enforces membership here.
 */
@ApiTags('Workspace members')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @ApiOkResponse({ type: [MemberResponseDto] })
  @Get()
  @ApiOperation({ summary: 'Members of the workspace' })
  list(@CurrentWorkspace() access: WorkspaceAccess): Promise<MemberResponseDto[]> {
    return this.members.list(access);
  }

  @RequireRole('ADMIN')
  @ApiCreatedResponse({ type: MemberResponseDto })
  @ApiConflictResponse({ description: 'Already a member' })
  @Post()
  @ApiOperation({ summary: 'Add an existing user by email (ADMIN)' })
  add(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Body() dto: AddMemberDto,
  ): Promise<MemberResponseDto> {
    return this.members.add(access, dto.email, dto.role);
  }

  @RequireRole('ADMIN')
  @ApiOkResponse({ type: MemberResponseDto })
  @ApiForbiddenResponse()
  @ApiConflictResponse({ description: 'Would leave the workspace without an owner' })
  @Patch(':userId')
  @ApiOperation({
    summary: "Change a member's role (ADMIN; only an OWNER can grant or remove OWNER)",
  })
  changeRole(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ): Promise<MemberResponseDto> {
    return this.members.changeRole(access, userId, dto.role);
  }

  /** ADMIN+ may remove others; any member may remove themselves (leave). */
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiForbiddenResponse()
  @ApiConflictResponse({ description: 'Would leave the workspace without an owner' })
  @Delete(':userId')
  @ApiOperation({ summary: 'Remove a member (ADMIN), or leave the workspace yourself' })
  remove(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.members.remove(access, userId);
  }
}
