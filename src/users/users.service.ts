import { Injectable } from '@nestjs/common';
import { AuditService, diff } from '../audit/audit.service';
import { auditActor, UserActor } from '../auth/actor';
import { PasswordService } from '../auth/password.service';
import { AppError } from '../common/errors/app-error';
import { isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { Prisma, Role, UserStatus } from '../generated/prisma/client';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  groupScopes: { select: { group: { select: { id: true, name: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function present(u: UserRow) {
  const { groupScopes, ...rest } = u;
  return { ...rest, groups: groupScopes.map((s) => s.group) };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateUserDto, actor: UserActor) {
    const email = dto.email.trim().toLowerCase();
    const groupIds = dto.role === Role.SUPER_ADMIN ? [] : [...new Set(dto.groupIds ?? [])];
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertGroupsExist(tx, groupIds);
        const user = await tx.user.create({
          data: {
            email,
            fullName: dto.fullName.trim(),
            role: dto.role,
            passwordHash,
            groupScopes: { create: groupIds.map((groupId) => ({ groupId })) },
          },
          select: USER_SELECT,
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'user.created',
          entityType: 'User',
          entityId: user.id,
          metadata: { email, role: dto.role, groupIds },
        });
        return present(user);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(ErrorCode.EMAIL_TAKEN, 'A user with this email already exists');
      throw e;
    }
  }

  async list(q: UserQueryDto) {
    const where: Prisma.UserWhereInput = {
      role: q.role,
      status: q.status,
      OR: q.q
        ? [{ email: { contains: q.q, mode: 'insensitive' } }, { fullName: { contains: q.q, mode: 'insensitive' } }]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: orderBy(q.sort, ['email', 'fullName', 'createdAt', 'role'], [{ createdAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.user.count({ where }),
    ]);
    return Page.of(rows.map(present), total, q);
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!user) throw AppError.notFound('User');
    return present(user);
  }

  async update(id: string, dto: UpdateUserDto, actor: UserActor) {
    if (id === actor.id && dto.role && dto.role !== actor.role) {
      throw AppError.rule(ErrorCode.CANNOT_MODIFY_SELF, 'You cannot change your own role');
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('User');
      const data = { fullName: dto.fullName?.trim(), role: dto.role };
      const user = await tx.user.update({ where: { id }, data, select: USER_SELECT });
      if (dto.role === Role.SUPER_ADMIN) await tx.userGroupScope.deleteMany({ where: { userId: id } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'user.updated',
        entityType: 'User',
        entityId: id,
        metadata: { changes: diff(before, data) },
      });
      return present(user);
    });
  }

  async setStatus(id: string, status: UserStatus, actor: UserActor) {
    if (id === actor.id) throw AppError.rule(ErrorCode.CANNOT_MODIFY_SELF, 'You cannot change your own account status');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('User');
      const user = await tx.user.update({ where: { id }, data: { status }, select: USER_SELECT });
      if (status === UserStatus.DISABLED) {
        await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: status === UserStatus.DISABLED ? 'user.disabled' : 'user.enabled',
        entityType: 'User',
        entityId: id,
      });
      return present(user);
    });
  }

  async setGroupScopes(id: string, groupIdsRaw: string[], actor: UserActor) {
    const groupIds = [...new Set(groupIdsRaw)];
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: { groupScopes: true } });
      if (!user) throw AppError.notFound('User');
      if (user.role === Role.SUPER_ADMIN && groupIds.length) {
        throw AppError.validation('SUPER_ADMIN users have global access and take no group scopes');
      }
      await this.assertGroupsExist(tx, groupIds);
      await tx.userGroupScope.deleteMany({ where: { userId: id } });
      await tx.userGroupScope.createMany({ data: groupIds.map((groupId) => ({ userId: id, groupId })) });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'user.group_scopes_changed',
        entityType: 'User',
        entityId: id,
        metadata: { from: user.groupScopes.map((s) => s.groupId), to: groupIds },
      });
      return present(await tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT }));
    });
  }

  async resetPassword(id: string, newPassword: string, actor: UserActor) {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw AppError.notFound('User');
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'user.password_reset',
        entityType: 'User',
        entityId: id,
      });
    });
  }

  private async assertGroupsExist(tx: Tx, groupIds: string[]) {
    if (!groupIds.length) return;
    const found = await tx.cdsGroup.count({ where: { id: { in: groupIds } } });
    if (found !== groupIds.length) throw AppError.validation('One or more groupIds do not exist');
  }
}
