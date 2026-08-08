import type { ClubRole, Member } from '../domain/entities.js';
import { forbidden } from '../lib/errors.js';

export const PERMISSIONS = [
  'events.manage',
  'members.manage',
  'newsletters.send',
  'projects.manage',
  'roles.manage',
  'teams.manage',
  'treasury.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<ClubRole, ReadonlySet<Permission>>> = {
  member: new Set(),
  president: new Set(PERMISSIONS),
  reservation_designee: new Set(['events.manage', 'newsletters.send']),
  treasurer: new Set(['newsletters.send', 'projects.manage', 'teams.manage', 'treasury.manage']),
  vice_president: new Set([
    'events.manage',
    'members.manage',
    'newsletters.send',
    'projects.manage',
    'teams.manage',
  ]),
};

export function hasPermission(member: Member, permission: Permission): boolean {
  return ROLE_PERMISSIONS[member.role].has(permission);
}

export function requirePermission(member: Member, permission: Permission): void {
  if (!hasPermission(member, permission)) {
    throw forbidden();
  }
}

export function requireOwnerOrPermission(
  member: Member,
  ownerId: string,
  permission: Permission,
): void {
  if (member.id !== ownerId && !hasPermission(member, permission)) {
    throw forbidden();
  }
}
