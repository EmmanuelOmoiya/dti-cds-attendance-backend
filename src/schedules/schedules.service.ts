import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, SYSTEM_ACTOR, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isExclusionViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { addDaysToIsoDate, assertTimezone, fromDateOnly, localDate, toDateOnly } from '../common/time/dates';
import { AppConfig } from '../config/config.module';
import {
  CancellationReason,
  CdsSchedule,
  GroupStatus,
  Prisma,
  ScheduleStatus,
  SessionOrigin,
  SessionStatus,
} from '../generated/prisma/client';
import { GroupsService } from '../groups/groups.service';
import { initialStatus } from '../sessions/session-lifecycle.policy';
import { SessionsService } from '../sessions/sessions.service';
import { occurrencesBetween, ScheduleRule } from './occurrence-calculator';
import { CreateScheduleDto, ScheduleQueryDto } from './schedules.dto';

export interface GenerationResult {
  scheduleId: string;
  candidates: number;
  created: number;
}

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly sessions: SessionsService,
  ) {}

  view(s: CdsSchedule) {
    return {
      ...s,
      effectiveFrom: fromDateOnly(s.effectiveFrom),
      effectiveUntil: s.effectiveUntil ? fromDateOnly(s.effectiveUntil) : null,
    };
  }

  rule(s: CdsSchedule): ScheduleRule {
    return {
      dayOfWeek: s.dayOfWeek,
      startLocalTime: s.startLocalTime,
      endLocalTime: s.endLocalTime,
      timezone: s.timezone,
      effectiveFrom: fromDateOnly(s.effectiveFrom),
      effectiveUntil: s.effectiveUntil ? fromDateOnly(s.effectiveUntil) : null,
    };
  }

  async create(dto: CreateScheduleDto, actor: UserActor) {
    const timezone = dto.timezone ?? this.config.APP_TIMEZONE;
    assertTimezone(timezone);
    if (dto.endLocalTime <= dto.startLocalTime) throw AppError.validation('endLocalTime must be after startLocalTime (meetings cannot cross midnight)');
    if (dto.effectiveUntil && dto.effectiveUntil < dto.effectiveFrom) throw AppError.validation('effectiveUntil must not be before effectiveFrom');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await GroupsService.requireActive(tx, dto.groupId, actor.scope);
        const schedule = await tx.cdsSchedule.create({
          data: {
            groupId: dto.groupId,
            title: dto.title.trim(),
            dayOfWeek: dto.dayOfWeek,
            startLocalTime: dto.startLocalTime,
            endLocalTime: dto.endLocalTime,
            timezone,
            effectiveFrom: toDateOnly(dto.effectiveFrom),
            effectiveUntil: dto.effectiveUntil ? toDateOnly(dto.effectiveUntil) : null,
            createdById: actor.id,
          },
        });
        const generation = await this.generateFor(tx, schedule, new Date(), dto.backfillPast ?? false);
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'schedule.created',
          entityType: 'CdsSchedule',
          entityId: schedule.id,
          groupId: schedule.groupId,
          metadata: { ...this.view(schedule), generatedSessions: generation.created },
        });
        return { ...this.view(schedule), generation };
      });
    } catch (e) {
      if (isExclusionViolation(e, 'CdsSchedule_no_overlap')) {
        throw AppError.conflict(ErrorCode.SCHEDULE_OVERLAP, 'An active schedule already covers this weekday for an overlapping period');
      }
      if (isExclusionViolation(e)) {
        throw AppError.conflict(ErrorCode.SESSION_OVERLAP, 'Generated sessions would overlap existing sessions of this group');
      }
      throw e;
    }
  }

  async list(q: ScheduleQueryDto, scope: AccessScope) {
    const where: Prisma.CdsScheduleWhereInput = { groupId: scope.narrow(q.groupId), status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cdsSchedule.findMany({ where, orderBy: orderBy(q.sort, ['createdAt', 'dayOfWeek', 'effectiveFrom'], [{ createdAt: 'desc' }]), ...paging(q) }),
      this.prisma.cdsSchedule.count({ where }),
    ]);
    return Page.of(rows.map((s) => this.view(s)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    const s = await this.load(this.prisma, id, scope);
    const upcoming = await this.prisma.attendanceSession.findMany({
      where: { scheduleId: id, plannedStart: { gte: new Date() } },
      orderBy: { plannedStart: 'asc' },
      take: 10,
    });
    return { ...this.view(s), upcomingSessions: upcoming.map((x) => this.sessions.view(x)) };
  }

  /** Only descriptive fields are editable; timing changes are made by ending this schedule and creating a new one. */
  async update(id: string, title: string | undefined, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      const updated = await tx.cdsSchedule.update({ where: { id }, data: { title: title?.trim() } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'schedule.updated',
        entityType: 'CdsSchedule',
        entityId: id,
        groupId: s.groupId,
        metadata: { title: { from: s.title, to: updated.title } },
      });
      return this.view(updated);
    });
  }

  /**
   * End the schedule after `effectiveUntil`. Future generated sessions after that date that are
   * still SCHEDULED and have no attendance data are cancelled (reason SCHEDULE_CHANGED); any with
   * data are left untouched and reported so an admin can decide. Past sessions are never modified.
   */
  async end(id: string, effectiveUntil: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      if (s.status !== ScheduleStatus.ACTIVE) throw AppError.transition('schedule', s.status, 'end');
      if (effectiveUntil < fromDateOnly(s.effectiveFrom)) throw AppError.validation('effectiveUntil must not be before effectiveFrom');
      const updated = await tx.cdsSchedule.update({ where: { id }, data: { effectiveUntil: toDateOnly(effectiveUntil) } });
      const result = await this.cancelFutureOccurrences(tx, s, { occurrenceDate: { gt: toDateOnly(effectiveUntil) } }, actor);
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'schedule.ended',
        entityType: 'CdsSchedule',
        entityId: id,
        groupId: s.groupId,
        metadata: { effectiveUntil, ...result },
      });
      return { ...this.view(updated), ...result };
    });
  }

  /** Stop the schedule entirely: no more generation; future untouched occurrences are cancelled. */
  async deactivate(id: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      if (s.status !== ScheduleStatus.ACTIVE) throw AppError.transition('schedule', s.status, 'deactivate');
      const updated = await tx.cdsSchedule.update({ where: { id }, data: { status: ScheduleStatus.INACTIVE } });
      const result = await this.cancelFutureOccurrences(tx, s, { plannedStart: { gt: new Date() } }, actor);
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'schedule.deactivated',
        entityType: 'CdsSchedule',
        entityId: id,
        groupId: s.groupId,
        metadata: result,
      });
      return { ...this.view(updated), ...result };
    });
  }

  async preview(id: string, from: string, to: string, scope: AccessScope) {
    const s = await this.load(this.prisma, id, scope);
    if (to < from) throw AppError.validation('to must not be before from');
    if (addDaysToIsoDate(from, 366) < to) throw AppError.validation('Preview range is limited to one year');
    return occurrencesBetween(this.rule(s), from, to);
  }

  /** Manually trigger generation for one schedule (same logic as the periodic job). */
  async generateNow(id: string, backfillPast: boolean, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.load(tx, id, actor.scope);
      if (s.status !== ScheduleStatus.ACTIVE) throw AppError.transition('schedule', s.status, 'generate sessions for');
      await GroupsService.requireActive(tx, s.groupId, actor.scope);
      const result = await this.generateFor(tx, s, new Date(), backfillPast);
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'session.generated',
        entityType: 'CdsSchedule',
        entityId: id,
        groupId: s.groupId,
        metadata: { ...result, backfillPast },
      });
      return result;
    });
  }

  /** Periodic job: generate the horizon for every active schedule of every active group. Idempotent. */
  async generateAll(now: Date, db: Tx | PrismaService = this.prisma): Promise<GenerationResult[]> {
    const schedules = await db.cdsSchedule.findMany({ where: { status: ScheduleStatus.ACTIVE, group: { status: GroupStatus.ACTIVE } } });
    const results: GenerationResult[] = [];
    for (const s of schedules) {
      const r = await this.generateFor(db, s, now, false);
      if (r.created > 0) {
        await this.audit.record(db, {
          actor: SYSTEM_ACTOR,
          action: 'session.generated',
          entityType: 'CdsSchedule',
          entityId: s.id,
          groupId: s.groupId,
          metadata: { ...r, job: 'generate-sessions' },
        });
      }
      results.push(r);
    }
    return results;
  }

  /**
   * Materialize expected occurrences from today (or effectiveFrom when back-filling) up to the
   * configured horizon. `ON CONFLICT DO NOTHING` (skipDuplicates) makes this idempotent: the
   * UNIQUE(scheduleId, occurrenceDate) key skips existing occurrences, and the no-overlap
   * exclusion constraint skips slots already taken by another session of the group.
   */
  private async generateFor(db: Tx | PrismaService, s: CdsSchedule, now: Date, backfillPast: boolean): Promise<GenerationResult> {
    const today = localDate(now, s.timezone);
    const from = backfillPast ? fromDateOnly(s.effectiveFrom) : today;
    const to = addDaysToIsoDate(today, this.config.SESSION_GENERATION_HORIZON_WEEKS * 7);
    const occurrences = occurrencesBetween(this.rule(s), from, to);
    if (!occurrences.length) return { scheduleId: s.id, candidates: 0, created: 0 };

    const { count } = await db.attendanceSession.createMany({
      data: occurrences.map((o) => ({
        groupId: s.groupId,
        scheduleId: s.id,
        origin: SessionOrigin.SCHEDULE,
        title: s.title,
        timezone: s.timezone,
        occurrenceDate: toDateOnly(o.occurrenceDate),
        plannedStart: o.plannedStart,
        plannedEnd: o.plannedEnd,
        status: initialStatus({ ...o, openedAt: null, closedAt: null }, now, this.sessions.timing),
        unresolvedAt: initialStatus({ ...o, openedAt: null, closedAt: null }, now, this.sessions.timing) === SessionStatus.UNRESOLVED ? now : null,
      })),
      skipDuplicates: true,
    });
    if (count < occurrences.length) {
      this.logger.debug(`Schedule ${s.id}: ${occurrences.length - count} occurrence(s) already existed or overlapped`);
    }
    return { scheduleId: s.id, candidates: occurrences.length, created: count };
  }

  private async cancelFutureOccurrences(tx: Tx, s: CdsSchedule, range: Prisma.AttendanceSessionWhereInput, actor: UserActor) {
    const future = await tx.attendanceSession.findMany({
      where: { scheduleId: s.id, status: SessionStatus.SCHEDULED, ...range },
      include: { _count: { select: { records: true, events: true } } },
    });
    const untouched = future.filter((f) => f._count.records === 0 && f._count.events === 0);
    const withData = future.filter((f) => f._count.records > 0 || f._count.events > 0);
    if (untouched.length) {
      await tx.attendanceSession.updateMany({
        where: { id: { in: untouched.map((u) => u.id) }, status: SessionStatus.SCHEDULED },
        data: {
          status: SessionStatus.CANCELLED,
          cancellationReason: CancellationReason.SCHEDULE_CHANGED,
          cancellationNote: 'Schedule ended or deactivated',
          cancelledAt: new Date(),
          cancelledById: actor.id,
        },
      });
    }
    return {
      cancelledSessionIds: untouched.map((u) => u.id),
      sessionsKeptWithAttendance: withData.map((w) => ({ id: w.id, occurrenceDate: fromDateOnly(w.occurrenceDate) })),
    };
  }

  private async load(db: Tx | PrismaService, id: string, scope: AccessScope) {
    const s = await db.cdsSchedule.findUnique({ where: { id } });
    if (!s || !scope.canAccess(s.groupId)) throw AppError.notFound('Schedule');
    return s;
  }
}
