import { SetMetadata } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';

export const REQUIRED_ROLE_KEY = 'requiredWorkspaceRole';

/**
 * Minimum workspace role for a `/workspaces/:workspaceId/...` route
 * (OWNER > ADMIN > MEMBER). Without it, any member may access the route.
 */
export const RequireRole = (role: WorkspaceRole) => SetMetadata(REQUIRED_ROLE_KEY, role);
