/**
 * Identity attached to `request.user` by the AuthGuard. Workspace access is resolved per
 * request from the route (Part 04), never from token claims, so role changes apply immediately.
 */
export interface AuthenticatedUser {
  userId: string;
}
