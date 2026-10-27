import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { GroupMembership, MemberStatus, MembershipEndReason, Prisma } from '../generated/prisma/client';
import { GroupsService } from '../groups/groups.service';
import { membershipStatus } from './members.service';
import { CorrectMembershipDto, CreateMembershipDto, EndMembershipDto, MembershipQueryDto } from './members.dto';
import { assertNoAttendanceOutside, mapMembershipOverlap } from './membership-guards';

const INCLUDE = {
  group: { select: { id: true, name: true } },
  member: { select: { id: true, fullName: true, stateCode: true, status: true } },
} satisfies Prisma.GroupMembershipInclude;

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  view(m: GroupMembership & Partial<Prisma.GroupMembershipGetPayload<{ include: typeof INCLUDE }>>) {
    return { ...m, status: membershipStatus(m) };
  }

  async list(q: MembershipQueryDto, scope: AccessScope) {
    const at = q.activeAt ? new Date(q.activeAt) : undefined;
    const where: Prisma.GroupMembershipWhereInput = {
      memberId: q.memberId,
      groupId: scope.narrow(q.groupId),
      ...(at ? { joinedAt: { lte: at }, OR: [{ leftAt: null }, { leftAt: { gt: at } }] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.groupMembership.findMany({
        where,
        include: INCLUDE,
        orderBy: orderBy(q.sort, ['joinedAt', 'leftAt', 'createdAt'], [{ joinedAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.groupMembership.count({ where }),
    ]);
    return Page.of(rows.map((r) => this.view(r)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    const m = await this.load(this.prisma, id, scope);
    return this.view(m);
  }

  /** Add a membership (new posting, or re-joining after a gap). Overlaps are rejected by the database. */
  async create(dto: CreateMembershipDto, actor: UserActor) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const member = await tx.member.findUnique({ where: { id: dto.memberId } });
        if (!member) throw AppError.notFound('Member');
        if (member.status !== MemberStatus.ACTIVE) throw AppError.rule(ErrorCode.MEMBER_INACTIVE, 'Reactivate the member before adding a membership');
        await GroupsService.requireActive(tx, dto.groupId, actor.scope);
        const m = await tx.groupMembership.create({
          data: { memberId: dto.memberId, groupId: dto.groupId, joinedAt: new Date(dto.joinedAt), createdById: actor.id },
          include: INCLUDE,
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'membership.started',
          entityType: 'GroupMembership',
          entityId: m.id,
          groupId: m.groupId,
          metadata: { memberId: m.memberId, joinedAt: m.joinedAt },
        });
        return this.view(m);
      });
    } catch (e) {
      return mapMembershipOverlap(e);
    }
  }

  /** End a membership (left the group, completed service, removed …). Sessions starting at/after leftAt are not eligible. */
  async end(id: string, dto: EndMembershipDto, actor: UserActor) {
    const leftAt = dto.leftAt ? new Date(dto.leftAt) : new Date();
    return this.prisma.$transaction(async (tx) => {
      const m = await this.load(tx, id, actor.scope);
      if (m.leftAt) throw AppError.transition('membership', 'ENDED', 'end');
      if (leftAt <= m.joinedAt) throw AppError.rule(ErrorCode.INVALID_TIME_RANGE, 'leftAt must be after joinedAt');
      await assertNoAttendanceOutside(tx, id, m.joinedAt, leftAt);
      const updated = await tx.groupMembership.update({
        where: { id },
        data: { leftAt, endReason: dto.reason, endNote: dto.note, endedById: actor.id },
        include: INCLUDE,
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'membership.ended',
        entityType: 'GroupMembership',
        entityId: id,
        groupId: m.groupId,
        metadata: { memberId: m.memberId, leftAt, reason: dto.reason, note: dto.note },
      });
      return this.view(updated);
    });
  }

  /**
   * Correct historical dates (data-entry mistakes). Audited with before/after. Refused when it
   * would overlap another membership or strand existing attendance outside the period.
   * Taps rejected because of the wrong dates can then be recovered via /attendance/events/reprocess.
   */
  async correct(id: string, dto: CorrectMembershipDto, actor: UserActor) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const m = await this.load(tx, id, actor.scope);
        const joinedAt = dto.joinedAt ? new Date(dto.joinedAt) : m.joinedAt;
        const leftAt = dto.leftAt === undefined ? m.leftAt : dto.leftAt === null ? null : new Date(dto.leftAt);
        if (leftAt && leftAt <= joinedAt) throw AppError.rule(ErrorCode.INVALID_TIME_RANGE, 'leftAt must be after joinedAt');
        await assertNoAttendanceOutside(tx, id, joinedAt, leftAt);
        const updated = await tx.groupMembership.update({
          where: { id },
          data: {
            joinedAt,
            leftAt,
            endReason: leftAt ? (m.endReason ?? MembershipEndReason.DATA_CORRECTION) : null,
            endNote: leftAt ? m.endNote : null,
          },
          include: INCLUDE,
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'membership.corrected',
          entityType: 'GroupMembership',
          entityId: id,
          groupId: m.groupId,
          metadata: {
            memberId: m.memberId,
            note: dto.note,
            from: { joinedAt: m.joinedAt, leftAt: m.leftAt },
            to: { joinedAt, leftAt },
          },
        });
        return this.view(updated);
      });
    } catch (e) {
      return mapMembershipOverlap(e);
    }
  }

  private async load(db: Tx | PrismaService, id: string, scope: AccessScope) {
    const m = await db.groupMembership.findUnique({ where: { id }, include: INCLUDE });
    if (!m || !scope.canAccess(m.groupId)) throw AppError.notFound('Membership');
    return m;
  }
}
