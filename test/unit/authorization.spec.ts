import { AccessScope } from '../../src/auth/access-scope';
import { Permission, PERMISSIONS_BY_ROLE, roleHasPermission } from '../../src/auth/permissions';
import { AppError } from '../../src/common/errors/app-error';
import { Role } from '../../src/generated/prisma/client';

const WRITE_PERMISSIONS = [
  Permission.USERS_MANAGE,
  Permission.GROUPS_CREATE,
  Permission.GROUPS_UPDATE,
  Permission.SCHEDULES_WRITE,
  Permission.SESSIONS_WRITE,
  Permission.MEMBERS_WRITE,
  Permission.CARDS_WRITE,
  Permission.ATTENDANCE_CORRECT,
  Permission.DEVICES_MANAGE,
];

describe('role → permission matrix', () => {
  it('SUPER_ADMIN has every permission', () => {
    for (const p of Object.values(Permission)) expect(roleHasPermission(Role.SUPER_ADMIN, p)).toBe(true);
  });

  it('LGI_VIEWER has no mutation permission', () => {
    for (const p of WRITE_PERMISSIONS) expect(roleHasPermission(Role.LGI_VIEWER, p)).toBe(false);
  });

  it('LGI_VIEWER can read attendance and reports', () => {
    for (const p of [Permission.ATTENDANCE_READ, Permission.REPORTS_READ, Permission.REPORTS_EXPORT, Permission.GROUPS_READ]) {
      expect(roleHasPermission(Role.LGI_VIEWER, p)).toBe(true);
    }
  });

  it('CDS_ADMIN manages its group domain but not users or group creation', () => {
    expect(roleHasPermission(Role.CDS_ADMIN, Permission.USERS_MANAGE)).toBe(false);
    expect(roleHasPermission(Role.CDS_ADMIN, Permission.GROUPS_CREATE)).toBe(false);
    for (const p of [Permission.MEMBERS_WRITE, Permission.CARDS_WRITE, Permission.SESSIONS_WRITE, Permission.DEVICES_MANAGE, Permission.REPORTS_EXPORT]) {
      expect(roleHasPermission(Role.CDS_ADMIN, p)).toBe(true);
    }
  });

  it('every role entry only references defined permissions', () => {
    const all = new Set(Object.values(Permission));
    for (const perms of Object.values(PERMISSIONS_BY_ROLE)) for (const p of perms) expect(all.has(p)).toBe(true);
  });
});

describe('AccessScope', () => {
  it('global scope allows any group', () => {
    const s = AccessScope.forRole(Role.SUPER_ADMIN, []);
    expect(s.canAccess('anything')).toBe(true);
    expect(s.groupFilter()).toBeUndefined();
  });

  it('group scope only allows listed groups and reports others as not found', () => {
    const s = AccessScope.forRole(Role.CDS_ADMIN, ['a']);
    expect(s.canAccess('a')).toBe(true);
    expect(s.canAccess('b')).toBe(false);
    expect(s.canAccess(null)).toBe(false);
    expect(() => s.assertGroup('b', 'Member')).toThrow(AppError);
    try {
      s.assertGroup('b', 'Member');
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
    expect(s.groupFilter()).toEqual({ in: ['a'] });
    expect(s.narrow()).toEqual({ in: ['a'] });
    expect(s.narrow('a')).toBe('a');
    expect(() => s.narrow('b')).toThrow(AppError);
  });

  it('a scoped user with no groups sees nothing', () => {
    expect(AccessScope.forRole(Role.LGI_VIEWER, []).groupFilter()).toEqual({ in: [] });
  });
});
