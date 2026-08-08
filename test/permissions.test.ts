import { describe, expect, it } from 'vitest';
import { hasPermission } from '../src/auth/permissions.js';
import type { ClubRole, Member } from '../src/domain/entities.js';

function memberWithRole(role: ClubRole): Member {
  return {
    createdAt: '',
    displayName: '',
    email: '',
    handle: '',
    id: '',
    identityProvider: 'entra',
    identitySubject: '',
    lastSeenAt: '',
    minors: [],
    role,
    status: 'active',
    techStack: [],
    updatedAt: '',
  };
}

describe('role permissions', () => {
  it('gives event management to the reservation designee', () => {
    expect(hasPermission(memberWithRole('reservation_designee'), 'events.manage')).toBe(true);
    expect(hasPermission(memberWithRole('reservation_designee'), 'roles.manage')).toBe(false);
  });

  it('reserves role assignment for the president', () => {
    expect(hasPermission(memberWithRole('vice_president'), 'roles.manage')).toBe(false);
    expect(hasPermission(memberWithRole('president'), 'roles.manage')).toBe(true);
  });

  it('does not grant officer permissions to a member', () => {
    expect(hasPermission(memberWithRole('member'), 'projects.manage')).toBe(false);
  });

  it('allows every officer role, but not members, to send newsletters', () => {
    for (const role of [
      'reservation_designee',
      'treasurer',
      'vice_president',
      'president',
    ] as const) {
      expect(hasPermission(memberWithRole(role), 'newsletters.send')).toBe(true);
    }
    expect(hasPermission(memberWithRole('member'), 'newsletters.send')).toBe(false);
  });
});
