import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { AuditActor, auditActor, SYSTEM_ACTOR, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isExclusionViolation, isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { assertTimezone, fromDateOnly, localDate, toDateOnly } from '../common/time/dates';
import { AppConfig } from '../config/config.module';
import {
  AttendanceRecordStatus,
  AttendanceSession,
  HeldConfirmation,
  Prisma,
  SessionOrigin,
  SessionStatus,
  VoidReason,
} from '../generated/prisma/client';
import { GroupsService } from '../groups/groups.service';
import * as policy from './session-lifecycle.policy';
import { admissionWindow, SessionTimingConfig, timingFromConfig } from './session-timing';
import { CancelSessionDto, ConfirmHeldDto, CreateSessionDto, SessionQueryDto, UpdateSessionDto } from './sessions.dto';

@Injectable()
export class SessionsService {
  readonly timing: SessionTimingConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {
    this.timing = timingFromConfig(config);
  }

  /** Public representation: dates as strings plus the computed admission window. */
  view(s: AttendanceSession) {
    const w = admissionWindow(s, this.timing);
    return {
      ...s,
      occurrenceDate: fromDateOnly(s.occurrenceDate),
      held: s.status === SessionStatus.CLOSED || s.status === SessionStatus.OPEN,
      admissionWindow: { start: w.start, end: w.end },
    };
  }

  async list(q: SessionQueryDto, scope: AccessScope) {
    const where: Prisma.AttendanceSessionWhereInput = {
      groupId: scope.narrow(q.groupId),
      status: q.needsResolution ? SessionStatus.UNRESOLVED : q.status,
      origin: q.origin,
      scheduleId: q.scheduleId,
      occurrenceDate: q.from || q.to ? { gte: q.from ? toDateOnly(q.from) : undefined, lte: q.to ? toDateOnly(q.to) : undefined } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceSession.findMany({
        where,
        orderBy: orderBy(q.sort, ['plannedStart', 'occurrenceDate', 'status', 'createdAt'], [{ plannedStart: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.attendanceSession.count({ where }),
    ]);
    return Page.of(rows.map((s) => this.view(s)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    const s = await this.load(this.prisma, id, scope);
    const [present, voided, events] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.count({ where: { sessionId: id, status: AttendanceRecordStatus.PRESENT } }),
      this.prisma.attendanceRecord.count({ where: { sessionId: id, status: AttendanceRecordStatus.VOIDED } }),
      this.prisma.attendanceEvent.groupBy({ by: ['ackStatus'], where: { sessionId: id }, _count: { _all: true }, orderBy: { ackStatus: 'asc' } }),
    ]);
    return {
      ...this.view(s),
      attendanceSummary: {
        present,
        voided,
        deviceEvents: Object.fromEntries(events.map((e) => [e.ackStatus, (e._count as { _all: number })._all])),
      },
    };
  }

  /** Ad-hoc session (special meeting outside the recurring schedule). */
  async create(dto: CreateSessionDto, actor: UserActor) {
    const timezone = dto.timezone ?? this.config.APP_TIMEZONE;
    assertTimezone(timezone);
    const plannedStart = new Date(dto.plannedStart);
    const plannedEnd = new Date(dto.plannedEnd);
    if (plannedEnd <= plannedStart) throw AppError.validation('plannedEnd must be after plannedStart');

    return this.mapConflicts(() =>
      this.prisma.$transaction(async (tx) => {
        await GroupsService.requireActive(tx, dto.groupId, actor.scope);
        const s = await tx.attendanceSession.create({
          data: {
            groupId: dto.groupId,
            origin: SessionOrigin.AD_HOC,
            title: dto.title.trim(),
            timezone,
            occurrenceDate: toDateOnly(localDate(plannedStart, timezone)),
            plannedStart,
            plannedEnd,
            status: policy.initialStatus({ plannedStart, plannedEnd, openedAt: null, closedAt: null }, new Date(), this.timing),
            createdById: actor.id,
          },
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'session.created',
          entityType: 'AttendanceSession',
          entityId: s.id,
          groupId: s.groupId,
          metadata: { origin: 'AD_HOC', plannedStart, plannedEnd, title: s.title },
        });
        return this.view(s);
      }),
    );
  }

  /** Edit title, or reschedule a single occurrence (SCHEDULED and no attendance yet). */
  async update(id: string, dto: UpdateSessionDto, actor: UserActor) {
    return this.mapConflicts(() =>
      this.prisma.$transaction(async (tx) => {
        const s = await this.load(tx, id, actor.scope);
        policy.assertEditable(s);
        const plannedStart = dto.plannedStart ? new Date(dto.plannedStart) : s.plannedStart;
        const plannedEnd = dto.plannedEnd ? new Date(dto.plannedEnd) : s.plannedEnd;
        const timesChanged = plannedStart.getTime() !== s.plannedStart.getTime() || plannedEnd.getTime() !== s.plannedEnd.getTime();
        if (plannedEnd <= plannedStart) throw AppError.validation('plannedEnd must be after plannedStart');
        if (timesChanged) await this.assertNoAttendance(tx, id);

        const updated = await tx.attendanceSession.update({
          where: { id },
          data: {
            title: dto.title?.trim(),
            ...(timesChanged
              ? { plannedStart, plannedEnd, rescheduled: true, occurrenceDate: toDateOnly(localDate(plannedStart, s.timezone)) }
              : {}),
          },
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: timesChanged ? 'session.rescheduled' : 'session.updated',
          entityType: 'AttendanceSession',
          entityId: id,
          groupId: s.groupId,
          metadata: {
            title: dto.title,
            ...(timesChanged ? { from: { plannedStart: s.plannedStart, plannedEnd: s.plannedEnd }, to: { plannedStart, plannedEnd } } : {}),
          },
        });
        return this.view(updated);
      }),
    );
  }

  /** The meeting is happening now: confirms it was held and records its live start. */
  async open(id: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      const now = new Date();
      policy.assertCanOpen(s, now, this.timing);
      await GroupsService.requireActive(tx, s.groupId, actor.scope);
      const updated = await this.transition(tx, s, {
        status: SessionStatus.OPEN,
        openedAt: now,
        heldConfirmation: HeldConfirmation.OPENED_LIVE,
        heldConfirmedAt: now,
        heldConfirmedById: actor.id,
      });
      await this.auditTransition(tx, auditActor(actor), 'session.opened', s);
      return this.view(updated);
    });
  }

  /** Stops attendance-taking. Taps captured before this moment are still accepted when uploaded later. */
  async close(id: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      policy.assertCanClose(s);
      const now = new Date();
      const closedAt = s.openedAt && now <= s.openedAt ? new Date(s.openedAt.getTime() + 1) : now;
      const updated = await this.transition(tx, s, { status: SessionStatus.CLOSED, closedAt });
      await this.auditTransition(tx, auditActor(actor), 'session.closed', s);
      return this.view(updated);
    });
  }

  /** After the fact: an authorized person states the meeting took place (resolves SCHEDULED/UNRESOLVED). */
  async confirmHeld(id: string, dto: ConfirmHeldDto, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      const now = new Date();
      policy.assertCanConfirmHeld(s, now);
      const openedAt = dto.openedAt ? new Date(dto.openedAt) : s.plannedStart;
      const closedAt = dto.closedAt ? new Date(dto.closedAt) : new Date(s.plannedEnd.getTime() + this.timing.closeGraceMinutes * 60_000);
      if (closedAt <= openedAt) throw AppError.validation('closedAt must be after openedAt');
      const updated = await this.transition(tx, s, {
        status: SessionStatus.CLOSED,
        openedAt,
        closedAt,
        heldConfirmation: HeldConfirmation.CONFIRMED_RETROSPECTIVELY,
        heldConfirmedAt: now,
        heldConfirmedById: actor.id,
      });
      await this.auditTransition(tx, auditActor(actor), 'session.held_confirmed', s, { openedAt, closedAt, note: dto.note });
      return this.view(updated);
    });
  }

  /**
   * An authorized person states the meeting did not happen. Existing PRESENT records must be
   * explicitly voided (voidExistingAttendance) so a cancelled session never carries attendance.
   */
  async cancel(id: string, dto: CancelSessionDto, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      policy.assertCanCancel(s, dto.note);
      const present = await tx.attendanceRecord.count({ where: { sessionId: id, status: AttendanceRecordStatus.PRESENT } });
      if (present > 0 && !dto.voidExistingAttendance) {
        throw AppError.conflict(
          ErrorCode.SESSION_HAS_ATTENDANCE,
          `The session has ${present} attendance record(s); pass voidExistingAttendance=true to void them`,
          { presentRecords: present },
        );
      }
      const now = new Date();
      let voided = 0;
      if (present > 0) {
        ({ count: voided } = await tx.attendanceRecord.updateMany({
          where: { sessionId: id, status: AttendanceRecordStatus.PRESENT },
          data: { status: AttendanceRecordStatus.VOIDED, voidReason: VoidReason.SESSION_CANCELLED, voidedAt: now, voidedById: actor.id, voidNote: 'Session cancelled' },
        }));
      }
      const updated = await this.transition(tx, s, {
        status: SessionStatus.CANCELLED,
        cancellationReason: dto.reason,
        cancellationNote: dto.note?.trim() || null,
        cancelledAt: now,
        cancelledById: actor.id,
      });
      await this.auditTransition(tx, auditActor(actor), 'session.cancelled', s, { reason: dto.reason, note: dto.note, voidedRecords: voided });
      return { ...this.view(updated), voidedRecords: voided };
    });
  }

  /**
   * Undo a cancellation: the session returns to SCHEDULED (or UNRESOLVED if its resolution deadline
   * passed) and records voided *because of the cancellation* are restored.
   */
  async reinstate(id: string, note: string, actor: UserActor) {
    return this.mapConflicts(() =>
      this.prisma.$transaction(async (tx) => {
        const s = await this.load(tx, id, actor.scope);
        policy.assertCanReinstate(s);
        const status = policy.statusAfterReinstate(s, new Date(), this.timing);
        const updated = await this.transition(tx, s, {
          status,
          cancellationReason: null,
          cancellationNote: null,
          cancelledAt: null,
          cancelledById: null,
          openedAt: null,
          closedAt: null,
          heldConfirmation: null,
          heldConfirmedAt: null,
          heldConfirmedById: null,
          unresolvedAt: status === SessionStatus.UNRESOLVED ? new Date() : null,
        });
        const { count: restored } = await tx.attendanceRecord.updateMany({
          where: { sessionId: id, status: AttendanceRecordStatus.VOIDED, voidReason: VoidReason.SESSION_CANCELLED },
          data: { status: AttendanceRecordStatus.PRESENT, voidReason: null, voidedAt: null, voidedById: null, voidNote: null },
        });
        await this.auditTransition(tx, auditActor(actor), 'session.reinstated', s, { note, restoredRecords: restored, newStatus: status });
        return { ...this.view(updated), restoredRecords: restored };
      }),
    );
  }

  // ───────────── System transitions (jobs) ─────────────

  /** SCHEDULED sessions whose resolution deadline passed become UNRESOLVED (never CANCELLED). */
  async markUnresolved(now: Date, db: Tx | PrismaService = this.prisma): Promise<number> {
    const threshold = new Date(now.getTime() - this.timing.unresolvedAfterHours * 3_600_000);
    const due = await db.attendanceSession.findMany({
      where: { status: SessionStatus.SCHEDULED, plannedEnd: { lt: threshold } },
      select: { id: true, groupId: true },
    });
    let changed = 0;
    for (const s of due) {
      const { count } = await db.attendanceSession.updateMany({
        where: { id: s.id, status: SessionStatus.SCHEDULED },
        data: { status: SessionStatus.UNRESOLVED, unresolvedAt: now },
      });
      if (count) {
        changed++;
        await this.audit.record(db, {
          actor: SYSTEM_ACTOR,
          action: 'session.marked_unresolved',
          entityType: 'AttendanceSession',
          entityId: s.id,
          groupId: s.groupId,
          metadata: { job: 'mark-unresolved' },
        });
      }
    }
    return changed;
  }

  /** OPEN sessions past plannedEnd + close grace are closed at that deterministic point. */
  async autoClose(now: Date, db: Tx | PrismaService = this.prisma): Promise<number> {
    const threshold = new Date(now.getTime() - this.timing.closeGraceMinutes * 60_000);
    const due = await db.attendanceSession.findMany({ where: { status: SessionStatus.OPEN, plannedEnd: { lt: threshold } } });
    let changed = 0;
    for (const s of due) {
      if (!policy.shouldAutoClose(s, now, this.timing)) continue;
      const { count } = await db.attendanceSession.updateMany({
        where: { id: s.id, status: SessionStatus.OPEN },
        data: { status: SessionStatus.CLOSED, closedAt: policy.autoCloseAt(s, this.timing) },
      });
      if (count) {
        changed++;
        await this.audit.record(db, {
          actor: SYSTEM_ACTOR,
          action: 'session.auto_closed',
          entityType: 'AttendanceSession',
          entityId: s.id,
          groupId: s.groupId,
          metadata: { job: 'auto-close' },
        });
      }
    }
    return changed;
  }

  // ───────────── helpers ─────────────

  async load(db: Tx | PrismaService, id: string, scope: AccessScope): Promise<AttendanceSession> {
    const s = await db.attendanceSession.findUnique({ where: { id } });
    if (!s || !scope.canAccess(s.groupId)) throw AppError.notFound('Session');
    return s;
  }

  /** Optimistic transition: only applies if the status is still what we validated against. */
  private async transition(tx: Tx, s: AttendanceSession, data: Prisma.AttendanceSessionUncheckedUpdateManyInput) {
    const { count } = await tx.attendanceSession.updateMany({ where: { id: s.id, status: s.status }, data });
    if (count !== 1) throw AppError.conflict(ErrorCode.CONFLICT, 'The session was modified concurrently; reload and retry');
    return tx.attendanceSession.findUniqueOrThrow({ where: { id: s.id } });
  }

  private auditTransition(tx: Tx, actor: AuditActor, action: string, s: AttendanceSession, metadata: Record<string, unknown> = {}) {
    return this.audit.record(tx, {
      actor,
      action,
      entityType: 'AttendanceSession',
      entityId: s.id,
      groupId: s.groupId,
      metadata: { fromStatus: s.status, ...metadata },
    });
  }

  private async assertNoAttendance(tx: Tx, sessionId: string) {
    const [records, events] = await Promise.all([
      tx.attendanceRecord.count({ where: { sessionId } }),
      tx.attendanceEvent.count({ where: { sessionId } }),
    ]);
    if (records || events) {
      throw AppError.conflict(ErrorCode.SESSION_HAS_ATTENDANCE, 'A session with attendance cannot be rescheduled', { records, events });
    }
  }

  private async mapConflicts<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isExclusionViolation(e, 'AttendanceSession_no_overlap') || isUniqueViolation(e)) {
        throw AppError.conflict(ErrorCode.SESSION_OVERLAP, 'Another session of this group already occupies that time');
      }
      throw e;
    }
  }
}
