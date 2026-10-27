import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { toDateOnly } from '../common/time/dates';
import {
  AttendanceRecordStatus,
  AttendanceSource,
  EventAckStatus,
  EventResolution,
  Prisma,
  SessionStatus,
  VoidReason,
} from '../generated/prisma/client';
import { eligibilityFor } from '../members/eligibility';
import { AttendanceIngestionService } from './attendance-ingestion.service';
import { AttendanceQueryDto, CreateManualAttendanceDto, EventQueryDto, ReprocessEventsDto } from './attendance.dto';

const RECORD_INCLUDE = {
  member: { select: { id: true, fullName: true, stateCode: true } },
  session: { select: { id: true, groupId: true, title: true, occurrenceDate: true, status: true } },
} satisfies Prisma.AttendanceRecordInclude;

type RecordRow = Prisma.AttendanceRecordGetPayload<{ include: typeof RECORD_INCLUDE }>;

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ingestion: AttendanceIngestionService,
  ) {}

  private view(r: RecordRow) {
    return { ...r, session: { ...r.session, occurrenceDate: r.session.occurrenceDate.toISOString().slice(0, 10) } };
  }

  async list(q: AttendanceQueryDto, scope: AccessScope) {
    const where: Prisma.AttendanceRecordWhereInput = {
      sessionId: q.sessionId,
      memberId: q.memberId,
      deviceId: q.deviceId,
      source: q.source,
      status: q.status,
      session: {
        groupId: scope.narrow(q.groupId),
        occurrenceDate: q.from || q.to ? { gte: q.from ? toDateOnly(q.from) : undefined, lte: q.to ? toDateOnly(q.to) : undefined } : undefined,
      },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        include: RECORD_INCLUDE,
        orderBy: orderBy(q.sort, ['capturedAt', 'receivedAt', 'createdAt'], [{ capturedAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);
    return Page.of(rows.map((r) => this.view(r)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    const r = await this.prisma.attendanceRecord.findUnique({ where: { id }, include: { ...RECORD_INCLUDE, sourceEvent: true } });
    if (!r || !scope.canAccess(r.session.groupId)) throw AppError.notFound('Attendance record');
    return { ...this.view(r), sourceEvent: r.sourceEvent };
  }

  /**
   * Administrative attendance (member forgot their card, device failure …). Same eligibility rule
   * as device taps — there is deliberately no override for ineligible members: correct the
   * membership instead, so "present ⊆ eligible" always holds.
   */
  async createManual(dto: CreateManualAttendanceDto, actor: UserActor) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const session = await tx.attendanceSession.findUnique({ where: { id: dto.sessionId } });
        if (!session || !actor.scope.canAccess(session.groupId)) throw AppError.notFound('Session');
        if (session.status === SessionStatus.CANCELLED) throw AppError.rule(ErrorCode.SESSION_CANCELLED, 'A cancelled session cannot hold attendance');
        const membershipId = await this.requireEligible(tx, dto.memberId, session.groupId, session.plannedStart);

        const existing = await tx.attendanceRecord.findUnique({ where: { sessionId_memberId: { sessionId: dto.sessionId, memberId: dto.memberId } } });
        if (existing) {
          throw AppError.conflict(ErrorCode.ATTENDANCE_ALREADY_RECORDED, 'The member already has a record for this session', {
            attendanceRecordId: existing.id,
            status: existing.status,
          });
        }
        const now = new Date();
        const record = await tx.attendanceRecord.create({
          data: {
            sessionId: dto.sessionId,
            memberId: dto.memberId,
            membershipId,
            source: AttendanceSource.MANUAL,
            capturedAt: now,
            receivedAt: now,
            note: dto.note,
            createdById: actor.id,
          },
          include: RECORD_INCLUDE,
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'attendance.manual_created',
          entityType: 'AttendanceRecord',
          entityId: record.id,
          groupId: session.groupId,
          metadata: { sessionId: dto.sessionId, memberId: dto.memberId, note: dto.note },
        });
        return this.view(record);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(ErrorCode.ATTENDANCE_ALREADY_RECORDED, 'The member already has a record for this session');
      throw e;
    }
  }

  /** Records are never deleted: voiding keeps the row and who/why. */
  async void(id: string, note: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.loadRecord(tx, id, actor.scope);
      if (r.status !== AttendanceRecordStatus.PRESENT) throw AppError.transition('attendance record', r.status, 'void');
      const updated = await tx.attendanceRecord.update({
        where: { id },
        data: { status: AttendanceRecordStatus.VOIDED, voidReason: VoidReason.ADMIN_CORRECTION, voidNote: note, voidedAt: new Date(), voidedById: actor.id },
        include: RECORD_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'attendance.voided',
        entityType: 'AttendanceRecord',
        entityId: id,
        groupId: r.session.groupId,
        metadata: { note, sessionId: r.sessionId, memberId: r.memberId },
      });
      return this.view(updated);
    });
  }

  async restore(id: string, note: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.loadRecord(tx, id, actor.scope);
      if (r.status !== AttendanceRecordStatus.VOIDED) throw AppError.transition('attendance record', r.status, 'restore');
      const session = await tx.attendanceSession.findUniqueOrThrow({ where: { id: r.sessionId } });
      if (session.status === SessionStatus.CANCELLED) throw AppError.rule(ErrorCode.SESSION_CANCELLED, 'Reinstate the session first');
      await this.requireEligible(tx, r.memberId, session.groupId, session.plannedStart);
      const updated = await tx.attendanceRecord.update({
        where: { id },
        data: { status: AttendanceRecordStatus.PRESENT, voidReason: null, voidNote: null, voidedAt: null, voidedById: null },
        include: RECORD_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'attendance.restored',
        entityType: 'AttendanceRecord',
        entityId: id,
        groupId: session.groupId,
        metadata: { note, previousVoidReason: r.voidReason },
      });
      return this.view(updated);
    });
  }

  // ───────────── Event inbox ─────────────

  async listEvents(q: EventQueryDto, scope: AccessScope) {
    const where: Prisma.AttendanceEventWhereInput = {
      ackStatus: q.ackStatus,
      ackReason: q.reason,
      resolution: q.resolution,
      deviceId: q.deviceId,
      sessionId: q.sessionId,
      memberId: q.memberId,
      device: { assignedGroupId: scope.narrow(q.groupId) },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceEvent.findMany({
        where,
        include: {
          device: { select: { id: true, deviceIdentifier: true, name: true } },
          member: { select: { id: true, fullName: true, stateCode: true } },
        },
        orderBy: orderBy(q.sort, ['receivedAt', 'capturedAt'], [{ receivedAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.attendanceEvent.count({ where }),
    ]);
    return Page.of(rows, total, q);
  }

  /**
   * Re-evaluate unresolved REJECTED events against current data. Useful after correcting a
   * membership date, back-dating a card assignment or reinstating a cancelled session.
   */
  async reprocess(dto: ReprocessEventsDto, actor: UserActor) {
    const where: Prisma.AttendanceEventWhereInput = {
      ackStatus: EventAckStatus.REJECTED,
      resolution: EventResolution.NONE,
      id: dto.eventIds ? { in: dto.eventIds } : undefined,
      OR: dto.sessionId ? [{ sessionId: dto.sessionId }, { claimedSessionId: dto.sessionId }] : undefined,
      memberId: dto.memberId,
      deviceId: dto.deviceId,
      ackReason: dto.reason,
      device: { assignedGroupId: actor.scope.groupFilter() },
    };
    const events = await this.prisma.attendanceEvent.findMany({
      where,
      include: { device: { select: { assignedGroupId: true } } },
      orderBy: { capturedAt: 'asc' },
      take: 500,
    });

    const results: { eventId: string; outcome: 'RECORD_CREATED' | 'ALREADY_RECORDED' | 'STILL_REJECTED'; reason?: string; attendanceRecordId?: string }[] = [];
    for (const event of events) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const r = await this.ingestion.reevaluate(tx, event);
        if (r.decision.decision === 'REJECT') return { eventId: event.id, outcome: 'STILL_REJECTED' as const, reason: r.decision.reason };
        const resolvedFields = { sessionId: r.decision.sessionId, memberId: r.decision.memberId, cardId: r.decision.cardId, cardAssignmentId: r.decision.cardAssignmentId };
        if (r.alreadyRecordedId) {
          await tx.attendanceEvent.update({
            where: { id: event.id },
            data: { ...resolvedFields, resolution: EventResolution.DISMISSED, resolutionNote: 'Member already recorded for this session', resolvedAt: new Date(), resolvedById: actor.id, attendanceRecordId: r.alreadyRecordedId },
          });
          return { eventId: event.id, outcome: 'ALREADY_RECORDED' as const, attendanceRecordId: r.alreadyRecordedId };
        }
        await tx.attendanceEvent.update({
          where: { id: event.id },
          data: { ...resolvedFields, resolution: EventResolution.RECORD_CREATED, resolvedAt: new Date(), resolvedById: actor.id, attendanceRecordId: r.recordId },
        });
        const session = await tx.attendanceSession.findUniqueOrThrow({ where: { id: r.decision.sessionId }, select: { groupId: true } });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'attendance.event_reprocessed',
          entityType: 'AttendanceEvent',
          entityId: event.id,
          groupId: session.groupId,
          metadata: { attendanceRecordId: r.recordId, originalReason: event.ackReason },
        });
        return { eventId: event.id, outcome: 'RECORD_CREATED' as const, attendanceRecordId: r.recordId };
      });
      results.push(outcome);
    }
    return {
      evaluated: results.length,
      recordsCreated: results.filter((r) => r.outcome === 'RECORD_CREATED').length,
      results,
    };
  }

  /** Mark a rejected event as reviewed with no action (e.g. a test tap). */
  async dismiss(eventId: string, note: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.attendanceEvent.findUnique({ where: { id: eventId }, include: { device: true } });
      if (!e || !actor.scope.canAccess(e.device.assignedGroupId)) throw AppError.notFound('Attendance event');
      if (e.ackStatus !== EventAckStatus.REJECTED || e.resolution !== EventResolution.NONE) {
        throw AppError.conflict(ErrorCode.EVENT_NOT_REJECTED, 'Only unresolved rejected events can be dismissed');
      }
      const updated = await tx.attendanceEvent.update({
        where: { id: eventId },
        data: { resolution: EventResolution.DISMISSED, resolutionNote: note, resolvedAt: new Date(), resolvedById: actor.id },
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'attendance.event_dismissed',
        entityType: 'AttendanceEvent',
        entityId: eventId,
        groupId: e.device.assignedGroupId,
        metadata: { note },
      });
      return updated;
    });
  }

  private async requireEligible(tx: Tx, memberId: string, groupId: string, sessionStart: Date): Promise<string> {
    const memberships = await tx.groupMembership.findMany({ where: { memberId }, select: { id: true, groupId: true, joinedAt: true, leftAt: true } });
    if (!memberships.length) throw AppError.notFound('Member');
    const e = eligibilityFor(memberships, groupId, sessionStart);
    if (!e.eligible) {
      throw AppError.rule(ErrorCode.MEMBER_NOT_ELIGIBLE, `The member was not eligible for this session (${e.reason})`, { reason: e.reason });
    }
    return e.membershipId;
  }

  private async loadRecord(tx: Tx, id: string, scope: AccessScope) {
    const r = await tx.attendanceRecord.findUnique({ where: { id }, include: RECORD_INCLUDE });
    if (!r || !scope.canAccess(r.session.groupId)) throw AppError.notFound('Attendance record');
    return r;
  }
}
