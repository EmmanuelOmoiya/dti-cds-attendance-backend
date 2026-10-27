import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isExclusionViolation, isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import {
  AssignmentEndReason,
  Card,
  CardAssignment,
  CardAssignmentStatus,
  CardRevokeReason,
  CardStatus,
  MemberStatus,
  Prisma,
} from '../generated/prisma/client';
import { membershipCovers } from '../members/eligibility';
import { MembersService } from '../members/members.service';
import { normalizeCardUid } from './card-uid';
import { AssignCardDto, AssignmentQueryDto, CardQueryDto, EndAssignmentDto, ReplaceCardDto, RevokeCardDto } from './cards.dto';

const ASSIGNMENT_INCLUDE = {
  member: { select: { id: true, fullName: true, stateCode: true } },
  card: { select: { id: true, cardUid: true, label: true, status: true } },
} satisfies Prisma.CardAssignmentInclude;

/** Ending reasons that mean the physical card must not be used again until reinstated. */
const REVOKING: Partial<Record<AssignmentEndReason, CardRevokeReason>> = {
  LOST: CardRevokeReason.LOST,
  DAMAGED: CardRevokeReason.DAMAGED,
  STOLEN: CardRevokeReason.STOLEN,
  REVOKED: CardRevokeReason.OTHER,
};

const REVOKE_TO_END_REASON: Record<CardRevokeReason, AssignmentEndReason> = {
  LOST: AssignmentEndReason.LOST,
  DAMAGED: AssignmentEndReason.DAMAGED,
  STOLEN: AssignmentEndReason.STOLEN,
  RETIRED: AssignmentEndReason.REVOKED,
  OTHER: AssignmentEndReason.REVOKED,
};

/**
 * Physical NFC cards (shared central inventory) and their time-bounded assignments to members.
 * Assignment history is never overwritten: ending or replacing creates/ends rows, and the
 * database guarantees no card has two holders and no member holds two cards at the same instant.
 */
@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly members: MembersService,
  ) {}

  // ───────────── Cards ─────────────

  async register(cardUidRaw: string, label: string | undefined, actor: UserActor) {
    const cardUid = normalizeCardUid(cardUidRaw);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const card = await this.registerIn(tx, cardUid, label, actor);
        return card;
      });
    } catch (e) {
      if (isUniqueViolation(e, 'cardUid')) throw AppError.conflict(ErrorCode.CARD_UID_TAKEN, 'This card is already registered');
      throw e;
    }
  }

  async list(q: CardQueryDto, scope: AccessScope) {
    const and: Prisma.CardWhereInput[] = [this.visibleCards(scope)];
    if (q.memberId) and.push({ assignments: { some: { memberId: q.memberId } } });
    const where: Prisma.CardWhereInput = {
      status: q.status,
      cardUid: q.cardUid ? normalizeCardUid(q.cardUid) : undefined,
      AND: and,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.card.findMany({
        where,
        include: { assignments: { where: { status: CardAssignmentStatus.ACTIVE }, include: ASSIGNMENT_INCLUDE } },
        orderBy: orderBy(q.sort, ['createdAt', 'cardUid', 'status'], [{ createdAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.card.count({ where }),
    ]);
    return Page.of(
      rows.map(({ assignments, ...card }) => ({ ...card, currentAssignment: assignments[0] ?? null })),
      total,
      q,
    );
  }

  /** Card with its full assignment history (scoped users only see holders from their groups). */
  async get(id: string, scope: AccessScope) {
    const card = await this.prisma.card.findUnique({
      where: { id },
      include: { assignments: { include: ASSIGNMENT_INCLUDE, orderBy: { assignedAt: 'desc' } } },
    });
    if (!card) throw AppError.notFound('Card');
    return this.presentWithHistory(card, scope);
  }

  async historyByUid(cardUidRaw: string, scope: AccessScope) {
    const card = await this.prisma.card.findUnique({ where: { cardUid: normalizeCardUid(cardUidRaw) } });
    if (!card) throw AppError.notFound('Card');
    return this.get(card.id, scope);
  }

  /** Revoke a physical card (lost, damaged, stolen, retired). Ends its active assignment, if any. */
  async revoke(id: string, dto: RevokeCardDto, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const card = await this.loadCard(tx, id);
      if (card.status === CardStatus.REVOKED) throw AppError.transition('card', card.status, 'revoke');
      const now = new Date();
      let endedAssignmentId: string | null = null;
      let groupId: string | null = null;
      const active = await tx.cardAssignment.findFirst({ where: { cardId: id, status: CardAssignmentStatus.ACTIVE } });
      if (active) {
        const member = await this.members.loadFull(tx, active.memberId);
        this.members.assertVisible(member, actor.scope);
        groupId = this.currentGroup(member);
        await this.endAssignmentRow(tx, active, now, REVOKE_TO_END_REASON[dto.reason], dto.note, actor.id);
        endedAssignmentId = active.id;
      }
      const updated = await tx.card.update({
        where: { id },
        data: { status: CardStatus.REVOKED, revokedAt: now, revokeReason: dto.reason, revokeNote: dto.note },
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'card.revoked',
        entityType: 'Card',
        entityId: id,
        groupId,
        metadata: { reason: dto.reason, note: dto.note, endedAssignmentId },
      });
      return updated;
    });
  }

  /** A revoked card was found/repaired: return it to stock (it can then be assigned again). */
  async reinstate(id: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const card = await this.loadCard(tx, id);
      if (card.status !== CardStatus.REVOKED) throw AppError.transition('card', card.status, 'reinstate');
      const updated = await tx.card.update({
        where: { id },
        data: { status: CardStatus.UNASSIGNED, revokedAt: null, revokeReason: null, revokeNote: null },
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'card.reinstated',
        entityType: 'Card',
        entityId: id,
        metadata: { previousRevokeReason: card.revokeReason },
      });
      return updated;
    });
  }

  // ───────────── Assignments ─────────────

  async listAssignments(q: AssignmentQueryDto, scope: AccessScope) {
    const at = q.activeAt ? new Date(q.activeAt) : undefined;
    const where: Prisma.CardAssignmentWhereInput = {
      memberId: q.memberId,
      cardId: q.cardId,
      status: q.status,
      ...(at ? { assignedAt: { lte: at }, OR: [{ endedAt: null }, { endedAt: { gt: at } }] } : {}),
      member: scope.all ? undefined : { memberships: { some: { groupId: { in: [...scope.groupIds] } } } },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cardAssignment.findMany({
        where,
        include: ASSIGNMENT_INCLUDE,
        orderBy: orderBy(q.sort, ['assignedAt', 'endedAt', 'createdAt'], [{ assignedAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.cardAssignment.count({ where }),
    ]);
    return Page.of(rows, total, q);
  }

  /** Give a card from stock to a member. Unknown UIDs are registered on the fly. */
  async assign(dto: AssignCardDto, actor: UserActor) {
    const assignedAt = dto.assignedAt ? new Date(dto.assignedAt) : new Date();
    if (assignedAt > new Date()) throw AppError.validation('assignedAt cannot be in the future');
    return this.mapAssignmentConflicts(() =>
      this.prisma.$transaction(async (tx) => {
        const member = await this.members.loadFull(tx, dto.memberId);
        this.members.assertVisible(member, actor.scope);
        if (member.status !== MemberStatus.ACTIVE) throw AppError.rule(ErrorCode.MEMBER_INACTIVE, 'Cannot assign a card to an inactive member');
        const existing = await tx.cardAssignment.findFirst({ where: { memberId: dto.memberId, status: CardAssignmentStatus.ACTIVE } });
        if (existing) throw AppError.conflict(ErrorCode.MEMBER_HAS_ACTIVE_CARD, 'The member already has an active card; use card replacement');

        const card = await this.resolveCardForAssignment(tx, dto.cardId, dto.cardUid, actor);
        const assignment = await tx.cardAssignment.create({
          data: { cardId: card.id, memberId: dto.memberId, assignedAt, assignedById: actor.id },
          include: ASSIGNMENT_INCLUDE,
        });
        await tx.card.update({ where: { id: card.id }, data: { status: CardStatus.ASSIGNED } });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'card.assigned',
          entityType: 'CardAssignment',
          entityId: assignment.id,
          groupId: this.currentGroup(member),
          metadata: { cardId: card.id, cardUid: card.cardUid, memberId: dto.memberId, assignedAt, backdated: !!dto.assignedAt },
        });
        return assignment;
      }),
    );
  }

  /** End an assignment (returned, lost, …). Lost/damaged/stolen also revoke the physical card. */
  async endAssignment(id: string, dto: EndAssignmentDto, actor: UserActor) {
    const endedAt = dto.endedAt ? new Date(dto.endedAt) : new Date();
    if (endedAt > new Date()) throw AppError.validation('endedAt cannot be in the future');
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.cardAssignment.findUnique({ where: { id } });
      if (!a) throw AppError.notFound('Card assignment');
      const member = await this.members.loadFull(tx, a.memberId);
      this.members.assertVisible(member, actor.scope);
      if (a.status !== CardAssignmentStatus.ACTIVE) throw AppError.transition('card assignment', a.status, 'end');
      if (endedAt <= a.assignedAt) throw AppError.rule(ErrorCode.INVALID_TIME_RANGE, 'endedAt must be after assignedAt');
      await this.endAssignmentRow(tx, a, endedAt, dto.reason, dto.note, actor.id);
      const revokeReason = REVOKING[dto.reason];
      await tx.card.update({
        where: { id: a.cardId },
        data: revokeReason
          ? { status: CardStatus.REVOKED, revokedAt: endedAt, revokeReason, revokeNote: dto.note }
          : { status: CardStatus.UNASSIGNED },
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: revokeReason ? 'card.revoked' : 'card_assignment.ended',
        entityType: 'CardAssignment',
        entityId: id,
        groupId: this.currentGroup(member),
        metadata: { cardId: a.cardId, memberId: a.memberId, endedAt, reason: dto.reason, note: dto.note },
      });
      return tx.cardAssignment.findUniqueOrThrow({ where: { id }, include: ASSIGNMENT_INCLUDE });
    });
  }

  /**
   * Replace a member's card atomically: the old assignment ends (reason REPLACED, history kept)
   * and the new card's assignment starts at the same instant. Taps made with the old card before
   * the replacement remain valid; taps after it are rejected as CARD_REVOKED.
   */
  async replace(memberId: string, dto: ReplaceCardDto, actor: UserActor) {
    return this.mapAssignmentConflicts(() =>
      this.prisma.$transaction(async (tx) => {
        const member = await this.members.loadFull(tx, memberId);
        this.members.assertVisible(member, actor.scope);
        if (member.status !== MemberStatus.ACTIVE) throw AppError.rule(ErrorCode.MEMBER_INACTIVE, 'Cannot issue a card to an inactive member');
        const old = await tx.cardAssignment.findFirst({ where: { memberId, status: CardAssignmentStatus.ACTIVE } });
        if (!old) throw AppError.rule(ErrorCode.MEMBER_HAS_NO_ACTIVE_CARD, 'The member has no active card to replace; assign one instead');

        const newCard = await this.resolveCardForAssignment(tx, dto.newCardId, dto.newCardUid, actor);
        if (newCard.id === old.cardId) throw AppError.validation('The new card must differ from the current card');
        const now = new Date();
        const at = now > old.assignedAt ? now : new Date(old.assignedAt.getTime() + 1);

        await this.endAssignmentRow(tx, old, at, AssignmentEndReason.REPLACED, dto.note, actor.id);
        const revokeReason = REVOKING[dto.reason as AssignmentEndReason];
        await tx.card.update({
          where: { id: old.cardId },
          data: revokeReason
            ? { status: CardStatus.REVOKED, revokedAt: at, revokeReason, revokeNote: dto.note }
            : { status: CardStatus.UNASSIGNED },
        });
        const next = await tx.cardAssignment.create({
          data: { cardId: newCard.id, memberId, assignedAt: at, assignedById: actor.id },
          include: ASSIGNMENT_INCLUDE,
        });
        await tx.cardAssignment.update({ where: { id: old.id }, data: { replacedByAssignmentId: next.id } });
        await tx.card.update({ where: { id: newCard.id }, data: { status: CardStatus.ASSIGNED } });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'card.replaced',
          entityType: 'Member',
          entityId: memberId,
          groupId: this.currentGroup(member),
          metadata: {
            reason: dto.reason,
            note: dto.note,
            oldAssignmentId: old.id,
            oldCardId: old.cardId,
            newAssignmentId: next.id,
            newCardId: newCard.id,
            oldCardRevoked: !!revokeReason,
          },
        });
        return { previousAssignmentId: old.id, assignment: next };
      }),
    );
  }

  // ───────────── helpers ─────────────

  private async registerIn(tx: Tx, cardUid: string, label: string | undefined, actor: UserActor): Promise<Card> {
    const card = await tx.card.create({ data: { cardUid, label: label?.trim() } });
    await this.audit.record(tx, {
      actor: auditActor(actor),
      action: 'card.registered',
      entityType: 'Card',
      entityId: card.id,
      metadata: { cardUid, label },
    });
    return card;
  }

  private async resolveCardForAssignment(tx: Tx, cardId: string | undefined, cardUidRaw: string | undefined, actor: UserActor): Promise<Card> {
    let card: Card | null;
    if (cardId) {
      card = await tx.card.findUnique({ where: { id: cardId } });
      if (!card) throw AppError.notFound('Card');
    } else {
      const cardUid = normalizeCardUid(cardUidRaw!);
      card = (await tx.card.findUnique({ where: { cardUid } })) ?? (await this.registerIn(tx, cardUid, undefined, actor));
    }
    if (card.status === CardStatus.ASSIGNED) throw AppError.conflict(ErrorCode.CARD_ALREADY_ASSIGNED, 'This card is already assigned to a member');
    if (card.status === CardStatus.REVOKED) throw AppError.rule(ErrorCode.CARD_NOT_ASSIGNABLE, 'This card is revoked; reinstate it before assigning');
    return card;
  }

  private endAssignmentRow(tx: Tx, a: CardAssignment, endedAt: Date, reason: AssignmentEndReason, note: string | undefined, actorId: string) {
    return tx.cardAssignment.update({
      where: { id: a.id },
      data: { status: CardAssignmentStatus.ENDED, endedAt, endReason: reason, endNote: note, endedById: actorId },
    });
  }

  private async loadCard(tx: Tx, id: string) {
    const card = await tx.card.findUnique({ where: { id } });
    if (!card) throw AppError.notFound('Card');
    return card;
  }

  /** Scoped users see shared stock plus cards ever held by members of their groups. */
  private visibleCards(scope: AccessScope): Prisma.CardWhereInput {
    if (scope.all) return {};
    return {
      OR: [
        { status: CardStatus.UNASSIGNED },
        { assignments: { some: { member: { memberships: { some: { groupId: { in: [...scope.groupIds] } } } } } } },
      ],
    };
  }

  private async presentWithHistory(
    card: Card & { assignments: Prisma.CardAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>[] },
    scope: AccessScope,
  ) {
    let assignments = card.assignments;
    if (!scope.all) {
      const visibleMembers = new Set(
        (
          await this.prisma.groupMembership.findMany({
            where: { memberId: { in: assignments.map((a) => a.memberId) }, groupId: { in: [...scope.groupIds] } },
            select: { memberId: true },
          })
        ).map((m) => m.memberId),
      );
      if (card.status !== CardStatus.UNASSIGNED && !assignments.some((a) => visibleMembers.has(a.memberId))) {
        throw AppError.notFound('Card');
      }
      assignments = assignments.filter((a) => visibleMembers.has(a.memberId));
    }
    return { ...card, assignments, currentAssignment: assignments.find((a) => a.status === CardAssignmentStatus.ACTIVE) ?? null };
  }

  private currentGroup(member: { memberships: { groupId: string; joinedAt: Date; leftAt: Date | null }[] }): string | null {
    return member.memberships.find((m) => membershipCovers(m, new Date()))?.groupId ?? null;
  }

  private async mapAssignmentConflicts<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isExclusionViolation(e, 'CardAssignment_card_no_overlap')) {
        throw AppError.conflict(ErrorCode.CARD_ALREADY_ASSIGNED, 'The card was held by someone else during that period');
      }
      if (isExclusionViolation(e, 'CardAssignment_member_no_overlap')) {
        throw AppError.conflict(ErrorCode.MEMBER_HAS_ACTIVE_CARD, 'The member already held a card during that period');
      }
      if (isUniqueViolation(e, 'cardUid')) throw AppError.conflict(ErrorCode.CARD_UID_TAKEN, 'This card is already registered');
      throw e;
    }
  }
}
