import { Global, Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { WorkspacePolicy } from './workspace-policy';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/** Global so the app-wide WorkspaceAccessGuard can inject WorkspacePolicy. */
@Global()
@Module({
  controllers: [WorkspacesController, MembersController],
  providers: [WorkspacesService, MembersService, WorkspacePolicy],
  exports: [WorkspacesService, WorkspacePolicy],
})
export class WorkspacesModule {}
