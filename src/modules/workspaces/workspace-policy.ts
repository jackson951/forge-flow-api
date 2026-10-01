import { ForbiddenException, Injectable } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';

const RANK: Record<WorkspaceRole, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1 };

export interface MemberRef {
  userId: string;
  role: WorkspaceRole;
}

/**
 * Pure role rules (no I/O), so they are unit-testable without HTTP or a database.
 * The "at least one OWNER" invariant needs a count and is enforced by MembersService.
 *
 * - MEMBER: may only leave.
 * - ADMIN: may add, re-role and remove non-owners, but never grant or touch OWNER.
 * - OWNER: may do everything.
 */
@Injectable()
export class WorkspacePolicy {
  hasRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
    return RANK[actual] >= RANK[required];
  }

  assertCanAdd(actor: MemberRef, newRole: WorkspaceRole): void {
    this.require(actor, 'ADMIN');
    if (newRole === 'OWNER') this.require(actor, 'OWNER');
  }

  assertCanChangeRole(actor: MemberRef, target: MemberRef, newRole: WorkspaceRole): void {
    this.require(actor, 'ADMIN');
    if (target.role === 'OWNER' || newRole === 'OWNER') this.require(actor, 'OWNER');
  }

  assertCanRemove(actor: MemberRef, target: MemberRef): void {
    if (actor.userId === target.userId) return; // anyone may leave
    this.require(actor, 'ADMIN');
    if (target.role === 'OWNER') this.require(actor, 'OWNER');
  }

  private require(actor: MemberRef, role: WorkspaceRole): void {
    if (!this.hasRole(actor.role, role)) {
      throw new ForbiddenException(`Requires ${role} role in this workspace`);
    }
  }
}
