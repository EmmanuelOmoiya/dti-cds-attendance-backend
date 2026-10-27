import { AppError } from '../common/errors/app-error';
import { Role } from '../generated/prisma/client';

/**
 * Which CDS groups the current user may see/act on. SUPER_ADMIN is global; CDS_ADMIN and
 * LGI_VIEWER are limited to their UserGroupScope rows.
 *
 * Out-of-scope resources are reported as 404 (not 403) so callers cannot discover what exists
 * in other groups.
 */
export class AccessScope {
  private constructor(
    readonly all: boolean,
    readonly groupIds: readonly string[],
  ) {}

  static global(): AccessScope {
    return new AccessScope(true, []);
  }

  static groups(groupIds: readonly string[]): AccessScope {
    return new AccessScope(false, [...new Set(groupIds)]);
  }

  static forRole(role: Role, groupIds: readonly string[]): AccessScope {
    return role === Role.SUPER_ADMIN ? AccessScope.global() : AccessScope.groups(groupIds);
  }

  canAccess(groupId: string | null | undefined): boolean {
    if (this.all) return true;
    return !!groupId && this.groupIds.includes(groupId);
  }

  /** Throws 404 `<entity> not found` when the group is outside scope. */
  assertGroup(groupId: string | null | undefined, entity = 'Group'): void {
    if (!this.canAccess(groupId)) throw AppError.notFound(entity);
  }

  /** Prisma filter for a `groupId` column: undefined when unrestricted. */
  groupFilter(): { in: string[] } | undefined {
    return this.all ? undefined : { in: [...this.groupIds] };
  }

  /** Intersects an optional requested group with the scope (404 if outside). */
  narrow(requestedGroupId?: string): { in: string[] } | string | undefined {
    if (requestedGroupId) {
      this.assertGroup(requestedGroupId);
      return requestedGroupId;
    }
    return this.groupFilter();
  }
}
