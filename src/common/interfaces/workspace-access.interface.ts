import { WorkspaceRole } from '@prisma/client';

/** The caller's verified membership, attached by the WorkspaceAccessGuard. */
export interface WorkspaceAccess {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}
