import { Injectable } from '@nestjs/common';
import { AuditService, diff } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import {
  AssignmentEndReason,
  CardAssignmentStatus,
  CardStatus,
  GroupMembership,
  MemberStatus,
  MembershipEndReason,
  Prisma,
} from '../generated/prisma/client';
import { GroupsService } from '../groups/groups.service';
import { membershipCovers } from './eligibility';
import { CreateMemberDto, DeactivateMemberDto, MemberQueryDto, TransferMemberDto, UpdateMemberDto } from './members.dto';
import { assertNoAttendanceOutside, mapMembershipOverlap } from './membership-guards';

export function normalizeStateCode(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}

export function membershipStatus(m: Pick<GroupMembership, 'joinedAt' | 'leftAt'>, now = new Date()): 'ACTIVE' | 'UPCOMING' | 'ENDED' {
  if (m.joinedAt > now) return 'UPCOMING';
  return membershipCovers(m, now) ? 'ACTIVE' : 'ENDED';
}

const MEMBER_INCLUDE = {
  memberships: { include: { group: { select: { id: true, name: true } } }, orderBy: { joinedAt: 'desc' } },
  cardAssignments: {
    where: { status: CardAssignmentStatus.ACTIVE },
    include: { card: { select: { id: true, cardUid: true, label: true } } },
  },
} satisfies Prisma.MemberInclude;

type MemberRow = Prisma.MemberGetPayload<{ include: typeof MEMBER_INCLUDE }>;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  present(m: MemberRow, now = new Date()) {
    const { memberships, cardAssignments, ...rest } = m;
    const views = memberships.map((ms) => ({ ...ms, status: membershipStatus(ms, now) }));
    const current = views.find((v) => v.status === 'ACTIVE') ?? null;
    return {
      ...rest,
      currentMembership: current,
      currentGroup: current?.group ?? null,
      activeCard: cardAssignments[0] ? { assignmentId: cardAssignments[0].id, assignedAt: cardAssignments[0].assignedAt, ...cardAssignments[0].card } : null,
      memberships: views,
    };
  }

  async create(dto: CreateMemberDto, actor: UserActor) {
    const stateCode = normalizeStateCode(dto.stateCode);
    const joinedAt = dto.joinedAt ? new Date(dto.joinedAt) : new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await GroupsService.requireActive(tx, dto.groupId, actor.scope);
        const member = await tx.member.create({ data: { fullName: dto.fullName.trim(), stateCode } });
        const membership = await tx.groupMembership.create({
          data: { memberId: member.id, groupId: dto.groupId, joinedAt, createdById: actor.id },
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'member.created',
          entityType: 'Member',
          entityId: member.id,
          groupId: dto.groupId,
          metadata: { stateCode, membershipId: membership.id, joinedAt },
        });
        return this.present(await this.loadFull(tx, member.id));
      });
    } catch (e) {
      if (isUniqueViolation(e, 'stateCode')) throw AppError.conflict(ErrorCode.STATE_CODE_TAKEN, 'A member with this state code already exists');
      throw e;
    }
  }

  async list(q: MemberQueryDto, scope: AccessScope) {
    const activeAt = q.activeAt ? new Date(q.activeAt) : new Date();
    const and: Prisma.MemberWhereInput[] = [];
    if (!scope.all) and.push({ memberships: { some: { groupId: { in: [...scope.groupIds] } } } });
    if (q.groupId) {
      scope.assertGroup(q.groupId);
      and.push({
        memberships: {
          some:
            q.membership === 'any'
              ? { groupId: q.groupId }
              : { groupId: q.groupId, joinedAt: { lte: activeAt }, OR: [{ leftAt: null }, { leftAt: { gt: activeAt } }] },
        },
      });
    }
    if (q.q) {
      and.push({ OR: [{ fullName: { contains: q.q, mode: 'insensitive' } }, { stateCode: { contains: q.q.toUpperCase() } }] });
    }
    const where: Prisma.MemberWhereInput = { status: q.status, AND: and };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: orderBy(q.sort, ['fullName', 'stateCode', 'createdAt', 'status'], [{ fullName: 'asc' }]),
        ...paging(q),
      }),
      this.prisma.member.count({ where }),
    ]);
    return Page.of(rows.map((r) => this.present(r)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    const m = await this.loadFull(this.prisma, id);
    this.assertVisible(m, scope);
    return this.present(m);
  }

  async update(id: string, dto: UpdateMemberDto, actor: UserActor) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await this.loadFull(tx, id);
        this.assertVisible(before, actor.scope);
        const data = { fullName: dto.fullName?.trim(), stateCode: dto.stateCode ? normalizeStateCode(dto.stateCode) : undefined };
        await tx.member.update({ where: { id }, data });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'member.updated',
          entityType: 'Member',
          entityId: id,
          groupId: this.currentGroupId(before),
          metadata: { changes: diff(before, data) },
        });
        return this.present(await this.loadFull(tx, id));
      });
    } catch (e) {
      if (isUniqueViolation(e, 'stateCode')) throw AppError.conflict(ErrorCode.STATE_CODE_TAKEN, 'A member with this state code already exists');
      throw e;
    }
  }

  /**
   * Deactivate a member (e.g. completed service): ends their current membership and active card
   * assignment at `effectiveAt`, in one transaction. History is preserved.
   */
  async deactivate(id: string, dto: DeactivateMemberDto, actor: UserActor) {
    const effectiveAt = dto.effectiveAt ? new Date(dto.effectiveAt) : new Date();
    if (effectiveAt > new Date()) throw AppError.validation('effectiveAt cannot be in the future');
    return this.prisma.$transaction(async (tx) => {
      const m = await this.loadFull(tx, id);
      this.assertVisible(m, actor.scope);
      if (m.status === MemberStatus.INACTIVE) throw AppError.transition('member', m.status, 'deactivate');

      const current = m.memberships.find((ms) => membershipCovers(ms, effectiveAt));
      if (current) {
        await assertNoAttendanceOutside(tx, current.id, current.joinedAt, effectiveAt);
        if (effectiveAt <= current.joinedAt) throw AppError.validation('effectiveAt must be after the membership start');
        await tx.groupMembership.update({
          where: { id: current.id },
          data: { leftAt: effectiveAt, endReason: MembershipEndReason.MEMBER_DEACTIVATED, endNote: dto.note, endedById: actor.id },
        });
      }
      const endedCard = await this.endActiveCard(tx, id, effectiveAt, AssignmentEndReason.MEMBER_LEFT, actor.id);
      await tx.member.update({ where: { id }, data: { status: MemberStatus.INACTIVE, deactivatedAt: effectiveAt } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'member.deactivated',
        entityType: 'Member',
        entityId: id,
        groupId: current?.groupId ?? this.currentGroupId(m),
        metadata: { effectiveAt, note: dto.note, endedMembershipId: current?.id ?? null, endedCardAssignmentId: endedCard },
      });
      return this.present(await this.loadFull(tx, id));
    });
  }

  /** Reactivates the person record. Memberships and cards are not restored: add them explicitly. */
  async reactivate(id: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const m = await this.loadFull(tx, id);
      this.assertVisible(m, actor.scope);
      if (m.status === MemberStatus.ACTIVE) throw AppError.transition('member', m.status, 'reactivate');
      await tx.member.update({ where: { id }, data: { status: MemberStatus.ACTIVE, deactivatedAt: null } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'member.reactivated',
        entityType: 'Member',
        entityId: id,
        groupId: this.currentGroupId(m),
      });
      return this.present(await this.loadFull(tx, id));
    });
  }

  /**
   * Move a member to another CDS group at `effectiveAt`: the current membership ends and the new
   * one starts at the same instant (atomically, linked). The member keeps their card.
   */
  async transfer(id: string, dto: TransferMemberDto, actor: UserActor) {
    const effectiveAt = dto.effectiveAt ? new Date(dto.effectiveAt) : new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const m = await this.loadFull(tx, id);
        if (m.status !== MemberStatus.ACTIVE) throw AppError.rule(ErrorCode.MEMBER_INACTIVE, 'Inactive members cannot be transferred');
        const current = m.memberships.find((ms) => membershipCovers(ms, effectiveAt));
        if (!current) throw AppError.rule(ErrorCode.NO_ACTIVE_MEMBERSHIP, 'The member has no membership at the transfer time');
        actor.scope.assertGroup(current.groupId, 'Member');
        await GroupsService.requireActive(tx, dto.toGroupId, actor.scope);
        if (current.groupId === dto.toGroupId) throw AppError.validation('The member already belongs to that group');
        if (effectiveAt <= current.joinedAt) throw AppError.validation('effectiveAt must be after the current membership start');
        await assertNoAttendanceOutside(tx, current.id, current.joinedAt, effectiveAt);

        // End first, then start: the half-open periods [joinedAt, leftAt) meet without overlapping.
        await tx.groupMembership.update({
          where: { id: current.id },
          data: { leftAt: effectiveAt, endReason: MembershipEndReason.TRANSFERRED, endNote: dto.note, endedById: actor.id },
        });
        const next = await tx.groupMembership.create({
          data: { memberId: id, groupId: dto.toGroupId, joinedAt: effectiveAt, createdById: actor.id },
        });
        await tx.groupMembership.update({ where: { id: current.id }, data: { transferredToMembershipId: next.id } });
        const meta = { fromGroupId: current.groupId, toGroupId: dto.toGroupId, effectiveAt, fromMembershipId: current.id, toMembershipId: next.id, note: dto.note };
        await this.audit.record(tx, { actor: auditActor(actor), action: 'member.transferred', entityType: 'Member', entityId: id, groupId: current.groupId, metadata: meta });
        await this.audit.record(tx, { actor: auditActor(actor), action: 'member.transferred', entityType: 'Member', entityId: id, groupId: dto.toGroupId, metadata: meta });
        return this.present(await this.loadFull(tx, id));
      });
    } catch (e) {
      return mapMembershipOverlap(e);
    }
  }

  /** Members are visible to scoped users when they have any membership (past or present) in a scoped group. */
  assertVisible(m: { memberships: { groupId: string }[] }, scope: AccessScope): void {
    if (scope.all) return;
    if (!m.memberships.some((ms) => scope.canAccess(ms.groupId))) throw AppError.notFound('Member');
  }

  async loadFull(db: Tx | PrismaService, id: string): Promise<MemberRow> {
    const m = await db.member.findUnique({ where: { id }, include: MEMBER_INCLUDE });
    if (!m) throw AppError.notFound('Member');
    return m;
  }

  private currentGroupId(m: MemberRow): string | null {
    return m.memberships.find((ms) => membershipCovers(ms, new Date()))?.groupId ?? null;
  }

  /** Ends the member's active card assignment (if any); the card returns to stock. Returns the assignment id. */
  private async endActiveCard(tx: Tx, memberId: string, at: Date, reason: AssignmentEndReason, actorId: string): Promise<string | null> {
    const active = await tx.cardAssignment.findFirst({ where: { memberId, status: CardAssignmentStatus.ACTIVE } });
    if (!active) return null;
    const endedAt = at > active.assignedAt ? at : new Date(active.assignedAt.getTime() + 1);
    await tx.cardAssignment.update({
      where: { id: active.id },
      data: { status: CardAssignmentStatus.ENDED, endedAt, endReason: reason, endedById: actorId },
    });
    await tx.card.update({ where: { id: active.cardId }, data: { status: CardStatus.UNASSIGNED } });
    return active.id;
  }

  /** Attendance records of one member (raw list; see /reports/members/:id for eligibility-based stats). */
  async attendance(id: string, scope: AccessScope, from?: string, to?: string) {
    const m = await this.loadFull(this.prisma, id);
    this.assertVisible(m, scope);
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        memberId: id,
        session: {
          groupId: scope.groupFilter(),
          occurrenceDate: from || to ? { gte: from ? new Date(`${from}T00:00:00Z`) : undefined, lte: to ? new Date(`${to}T00:00:00Z`) : undefined } : undefined,
        },
      },
      include: { session: { select: { id: true, title: true, occurrenceDate: true, status: true, groupId: true } } },
      orderBy: { capturedAt: 'desc' },
      take: 500,
    });
    return rows.map((r) => ({ ...r, session: { ...r.session, occurrenceDate: r.session.occurrenceDate.toISOString().slice(0, 10) } }));
  }
}

