import { Role } from '../generated/prisma/client';

/** Every permission the API checks. Routes declare what they need via @RequirePermissions. */
export const Permission = {
  USERS_MANAGE: 'users:manage',
  GROUPS_CREATE: 'groups:create',
  GROUPS_READ: 'groups:read',
  GROUPS_UPDATE: 'groups:update',
  SCHEDULES_READ: 'schedules:read',
  SCHEDULES_WRITE: 'schedules:write',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_WRITE: 'sessions:write',
  MEMBERS_READ: 'members:read',
  MEMBERS_WRITE: 'members:write',
  CARDS_READ: 'cards:read',
  CARDS_WRITE: 'cards:write',
  ATTENDANCE_READ: 'attendance:read',
  ATTENDANCE_CORRECT: 'attendance:correct',
  REPORTS_READ: 'reports:read',
  REPORTS_EXPORT: 'reports:export',
  DEVICES_READ: 'devices:read',
  DEVICES_MANAGE: 'devices:manage',
  AUDIT_READ: 'audit:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

/**
 * Explicit role → permission matrix (see docs/SECURITY.md).
 * Group scoping (which groups a CDS_ADMIN / LGI_VIEWER may touch) is enforced separately by AccessScope.
 */
export const PERMISSIONS_BY_ROLE: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  CDS_ADMIN: [
    Permission.GROUPS_READ,
    Permission.GROUPS_UPDATE,
    Permission.SCHEDULES_READ,
    Permission.SCHEDULES_WRITE,
    Permission.SESSIONS_READ,
    Permission.SESSIONS_WRITE,
    Permission.MEMBERS_READ,
    Permission.MEMBERS_WRITE,
    Permission.CARDS_READ,
    Permission.CARDS_WRITE,
    Permission.ATTENDANCE_READ,
    Permission.ATTENDANCE_CORRECT,
    Permission.REPORTS_READ,
    Permission.REPORTS_EXPORT,
    Permission.DEVICES_READ,
    Permission.DEVICES_MANAGE,
    Permission.AUDIT_READ,
  ],
  LGI_VIEWER: [
    Permission.GROUPS_READ,
    Permission.SCHEDULES_READ,
    Permission.SESSIONS_READ,
    Permission.MEMBERS_READ,
    Permission.CARDS_READ,
    Permission.ATTENDANCE_READ,
    Permission.REPORTS_READ,
    Permission.REPORTS_EXPORT,
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].includes(permission);
}
