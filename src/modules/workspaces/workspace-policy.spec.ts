import { ForbiddenException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { MemberRef, WorkspacePolicy } from './workspace-policy';

const policy = new WorkspacePolicy();
const as = (role: WorkspaceRole, userId = `actor-${role}`): MemberRef => ({ userId, role });
const target = (role: WorkspaceRole): MemberRef => ({ userId: `target-${role}`, role });

const ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

describe('WorkspacePolicy', () => {
  describe('hasRole', () => {
    it.each([
      ['OWNER', 'OWNER', true],
      ['OWNER', 'MEMBER', true],
      ['ADMIN', 'ADMIN', true],
      ['ADMIN', 'OWNER', false],
      ['MEMBER', 'MEMBER', true],
      ['MEMBER', 'ADMIN', false],
    ] as const)('%s satisfies %s: %s', (actual, required, expected) => {
      expect(policy.hasRole(actual, required)).toBe(expected);
    });
  });

  describe('assertCanAdd', () => {
    it.each([
      ['OWNER', 'OWNER', true],
      ['OWNER', 'ADMIN', true],
      ['ADMIN', 'ADMIN', true],
      ['ADMIN', 'MEMBER', true],
      ['ADMIN', 'OWNER', false],
      ['MEMBER', 'MEMBER', false],
    ] as const)('%s adding a %s → allowed: %s', (actor, newRole, allowed) => {
      const call = () => policy.assertCanAdd(as(actor), newRole);
      if (allowed) expect(call).not.toThrow();
      else expect(call).toThrow(ForbiddenException);
    });
  });

  describe('assertCanChangeRole', () => {
    // [actor, target's current role, new role, allowed]
    it.each([
      ['OWNER', 'OWNER', 'ADMIN', true],
      ['OWNER', 'MEMBER', 'OWNER', true],
      ['ADMIN', 'MEMBER', 'ADMIN', true],
      ['ADMIN', 'ADMIN', 'MEMBER', true],
      ['ADMIN', 'MEMBER', 'OWNER', false],
      ['ADMIN', 'OWNER', 'ADMIN', false],
      ['MEMBER', 'MEMBER', 'ADMIN', false],
    ] as const)('%s changing %s → %s: allowed %s', (actor, current, next, allowed) => {
      const call = () => policy.assertCanChangeRole(as(actor), target(current), next);
      if (allowed) expect(call).not.toThrow();
      else expect(call).toThrow(ForbiddenException);
    });

    it('an ADMIN cannot promote themselves to OWNER', () => {
      const self = as('ADMIN', 'same');
      expect(() => policy.assertCanChangeRole(self, self, 'OWNER')).toThrow(ForbiddenException);
    });
  });

  describe('assertCanRemove', () => {
    it.each([
      ['OWNER', 'OWNER', true],
      ['OWNER', 'MEMBER', true],
      ['ADMIN', 'MEMBER', true],
      ['ADMIN', 'ADMIN', true],
      ['ADMIN', 'OWNER', false],
      ['MEMBER', 'MEMBER', false],
    ] as const)('%s removing a %s: allowed %s', (actor, targetRole, allowed) => {
      const call = () => policy.assertCanRemove(as(actor), target(targetRole));
      if (allowed) expect(call).not.toThrow();
      else expect(call).toThrow(ForbiddenException);
    });

    it.each(ROLES)('a %s may always remove themselves (leave)', (role) => {
      const self = as(role, 'same');
      expect(() => policy.assertCanRemove(self, self)).not.toThrow();
    });
  });
});
