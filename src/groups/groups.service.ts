import { Injectable } from '@nestjs/common';
import { AuditService, diff } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { CdsGroup, GroupStatus, Prisma, SessionStatus } from '../generated/prisma/client';
import { CreateGroupDto, GroupQueryDto, UpdateGroupDto } from './groups.dto';

const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateGroupDto, actor: UserActor) {
    const name = dto.name.trim().replace(/\s+/g, ' ');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const group = await tx.cdsGroup.create({
          data: { name, nameNormalized: normalize(name), description: dto.description?.trim() },
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'group.created',
          entityType: 'CdsGroup',
          entityId: group.id,
          groupId: group.id,
          metadata: { name },
        });
        return this.present(group);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(ErrorCode.GROUP_NAME_TAKEN, 'A group with this name already exists');
      throw e;
    }
  }

  async list(q: GroupQueryDto, scope: AccessScope) {
    const where: Prisma.CdsGroupWhereInput = {
      id: scope.groupFilter(),
      status: q.status,
      name: q.q ? { contains: q.q, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cdsGroup.findMany({ where, orderBy: orderBy(q.sort, ['name', 'createdAt', 'status'], [{ name: 'asc' }]), ...paging(q) }),
      this.prisma.cdsGroup.count({ where }),
    ]);
    return Page.of(rows.map((g) => this.present(g)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    scope.assertGroup(id);
    const group = await this.prisma.cdsGroup.findUnique({ where: { id } });
    if (!group) throw AppError.notFound('Group');
    const now = new Date();
    const [activeMembers, devices, activeSchedules] = await this.prisma.$transaction([
      this.prisma.groupMembership.count({
        where: { groupId: id, joinedAt: { lte: now }, OR: [{ leftAt: null }, { leftAt: { gt: now } }] },
      }),
      this.prisma.device.count({ where: { assignedGroupId: id } }),
      this.prisma.cdsSchedule.count({ where: { groupId: id, status: 'ACTIVE' } }),
    ]);
    return { ...this.present(group), stats: { activeMembers, devices, activeSchedules } };
  }

  async update(id: string, dto: UpdateGroupDto, actor: UserActor) {
    actor.scope.assertGroup(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await this.load(tx, id);
        const name = dto.name?.trim().replace(/\s+/g, ' ');
        const data = { name, nameNormalized: name ? normalize(name) : undefined, description: dto.description?.trim() };
        const group = await tx.cdsGroup.update({ where: { id }, data });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'group.updated',
          entityType: 'CdsGroup',
          entityId: id,
          groupId: id,
          metadata: { changes: diff(before, { name: data.name, description: data.description }) },
        });
        return this.present(group);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(ErrorCode.GROUP_NAME_TAKEN, 'A group with this name already exists');
      throw e;
    }
  }

  async setStatus(id: string, status: GroupStatus, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status === status) return this.present(before);
      if (status === GroupStatus.INACTIVE) {
        const open = await tx.attendanceSession.count({ where: { groupId: id, status: SessionStatus.OPEN } });
        if (open) throw AppError.conflict(ErrorCode.GROUP_HAS_OPEN_SESSIONS, 'Close open sessions before deactivating the group');
      }
      const group = await tx.cdsGroup.update({ where: { id }, data: { status } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: status === GroupStatus.INACTIVE ? 'group.deactivated' : 'group.activated',
        entityType: 'CdsGroup',
        entityId: id,
        groupId: id,
      });
      return this.present(group);
    });
  }

  /** Loads a group the caller is allowed to act on and that is ACTIVE (for writes into the group). */
  static async requireActive(tx: Tx | PrismaService, groupId: string, scope: AccessScope): Promise<CdsGroup> {
    scope.assertGroup(groupId);
    const group = await tx.cdsGroup.findUnique({ where: { id: groupId } });
    if (!group) throw AppError.notFound('Group');
    if (group.status !== GroupStatus.ACTIVE) throw AppError.rule(ErrorCode.GROUP_INACTIVE, 'The group is inactive');
    return group;
  }

  private async load(tx: Tx, id: string) {
    const group = await tx.cdsGroup.findUnique({ where: { id } });
    if (!group) throw AppError.notFound('Group');
    return group;
  }

  private present(g: CdsGroup) {
    const { nameNormalized: _ignored, ...rest } = g;
    return rest;
  }
}
