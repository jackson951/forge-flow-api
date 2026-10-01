import { NotImplementedException } from '@nestjs/common';

/**
 * Interim placeholder for scaffold routes that need a workspace. They used to read a
 * `workspaceId` token claim that real access tokens deliberately do not carry. These routes
 * move under `/workspaces/:workspaceId` in Part 04/05; until then they fail explicitly.
 */
export function pendingWorkspaceScope(): never {
  throw new NotImplementedException('Workspace-scoped routes are not available yet (Part 04)');
}
