import { Injectable } from '@nestjs/common';
import { AccessScope } from '../auth/access-scope';
import { AppError } from '../common/errors/app-error';
import { PrismaService } from '../common/prisma/prisma.service';
import { fromDateOnly } from '../common/time/dates';
import { Prisma, SessionStatus } from '../generated/prisma/client';
import { ReportTable } from './formatters';

/**
 * Eligibility-based attendance reporting.
 *
 *  • Only HELD sessions (status CLOSED) count toward statistics. OPEN sessions are shown live but
 *    are not final; CANCELLED sessions never count; UNRESOLVED sessions are excluded and reported
 *    as a data-quality warning rather than silently treated as absences.
 *  • A member is eligible for a session iff a membership in the session's group satisfies
 *      joinedAt <= plannedStart AND (leftAt IS NULL OR leftAt > plannedStart).
 *  • absent = eligible − present;  rate = present / eligible.
 */

const ELIGIBLE = Prisma.sql`gm."joinedAt" <= s."plannedStart" AND (gm."leftAt" IS NULL OR gm."leftAt" > s."plannedStart")`;
const MIN_DATE = '1900-01-01';
const MAX_DATE = '2999-12-31';

const rate = (present: number, eligible: number): number | null => (eligible > 0 ? Math.round((present / eligible) * 10000) / 100 : null);
const n = (v: unknown): number => Number(v ?? 0);

export type Participation = 'PRESENT' | 'ABSENT' | 'NOT_RECORDED' | 'CANCELLED' | 'PENDING_RESOLUTION' | 'UPCOMING';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────── Session ─────────────

  async sessionReport(sessionId: string, scope: AccessScope) {
    const session = await this.prisma.attendanceSession.findUnique({ where: { id: sessionId }, include: { group: { select: { name: true } } } });
    if (!session || !scope.canAccess(session.groupId)) throw AppError.notFound('Session');
    const held = session.status === SessionStatus.CLOSED || session.status === SessionStatus.OPEN;

    const rows = await this.prisma.$queryRaw<
      { memberId: string; fullName: string; stateCode: string; membershipId: string; recordId: string | null; recordStatus: string | null; capturedAt: Date | null; source: string | null; lateSync: boolean | null }[]
    >`
      SELECT m.id AS "memberId", m."fullName", m."stateCode", gm.id AS "membershipId",
             r.id AS "recordId", r.status::text AS "recordStatus", r."capturedAt", r.source::text AS source, r."lateSync"
      FROM "AttendanceSession" s
      JOIN "GroupMembership" gm ON gm."groupId" = s."groupId" AND ${ELIGIBLE}
      JOIN "Member" m ON m.id = gm."memberId"
      LEFT JOIN "AttendanceRecord" r ON r."sessionId" = s.id AND r."memberId" = m.id
      WHERE s.id = ${sessionId}::uuid
      ORDER BY m."fullName", m."stateCode"`;

    const members = rows.map((r) => {
      const present = r.recordStatus === 'PRESENT';
      const participation: Participation =
        session.status === SessionStatus.CANCELLED ? 'CANCELLED' : present ? 'PRESENT' : held ? 'ABSENT' : 'NOT_RECORDED';
      return { ...r, participation };
    });
    const eligible = members.length;
    const present = members.filter((m) => m.recordStatus === 'PRESENT').length;
    const countsTowardStatistics = session.status === SessionStatus.CLOSED;

    return {
      session: {
        id: session.id,
        groupId: session.groupId,
        groupName: session.group.name,
        title: session.title,
        occurrenceDate: fromDateOnly(session.occurrenceDate),
        plannedStart: session.plannedStart,
        plannedEnd: session.plannedEnd,
        status: session.status,
        cancellationReason: session.cancellationReason,
      },
      summary: {
        countsTowardStatistics,
        eligible,
        present,
        absent: held ? eligible - present : null,
        attendanceRate: held ? rate(present, eligible) : null,
      },
      members,
    };
  }

  sessionTable(r: Awaited<ReturnType<ReportsService['sessionReport']>>): ReportTable {
    return {
      title: `session-${r.session.occurrenceDate}`,
      columns: [
        { key: 'stateCode', header: 'State code' },
        { key: 'fullName', header: 'Full name' },
        { key: 'participation', header: 'Participation' },
        { key: 'capturedAt', header: 'Recorded at (UTC)' },
        { key: 'source', header: 'Source' },
      ],
      rows: r.members,
    };
  }

  // ───────────── Group ─────────────

  async groupReport(groupId: string, scope: AccessScope, from?: string, to?: string) {
    const group = await this.loadGroup(groupId, scope);
    const rows = await this.prisma.$queryRaw<
      { id: string; occurrenceDate: Date; title: string; status: SessionStatus; cancellationReason: string | null; plannedStart: Date; eligible: bigint; present: bigint; records: bigint }[]
    >`
      SELECT s.id, s."occurrenceDate", s.title, s.status, s."cancellationReason"::text AS "cancellationReason", s."plannedStart",
        (SELECT count(*) FROM "GroupMembership" gm WHERE gm."groupId" = s."groupId" AND ${ELIGIBLE}) AS eligible,
        (SELECT count(*) FROM "AttendanceRecord" r
           WHERE r."sessionId" = s.id AND r.status = 'PRESENT'
             AND EXISTS (SELECT 1 FROM "GroupMembership" gm WHERE gm."memberId" = r."memberId" AND gm."groupId" = s."groupId" AND ${ELIGIBLE})) AS present,
        (SELECT count(*) FROM "AttendanceRecord" r WHERE r."sessionId" = s.id AND r.status = 'PRESENT') AS records
      FROM "AttendanceSession" s
      WHERE s."groupId" = ${groupId}::uuid
        AND s."occurrenceDate" BETWEEN ${from ?? MIN_DATE}::date AND ${to ?? MAX_DATE}::date
      ORDER BY s."plannedStart"`;

    const sessions = rows.map((r) => {
      const eligible = n(r.eligible);
      const present = n(r.present);
      const counts = r.status === SessionStatus.CLOSED;
      const held = counts || r.status === SessionStatus.OPEN;
      return {
        sessionId: r.id,
        occurrenceDate: fromDateOnly(r.occurrenceDate),
        title: r.title,
        status: r.status,
        cancellationReason: r.cancellationReason,
        countsTowardStatistics: counts,
        eligible,
        present: r.status === SessionStatus.CANCELLED ? 0 : present,
        absent: held ? eligible - present : null,
        attendanceRate: held ? rate(present, eligible) : null,
        recordsAttached: n(r.records),
      };
    });

    const heldSessions = sessions.filter((s) => s.countsTowardStatistics);
    const totalEligible = heldSessions.reduce((a, s) => a + s.eligible, 0);
    const totalPresent = heldSessions.reduce((a, s) => a + s.present, 0);
    const sessionRates = heldSessions.map((s) => s.attendanceRate).filter((x): x is number => x !== null);
    const unresolved = sessions.filter((s) => s.status === SessionStatus.UNRESOLVED);
    const cancelled = sessions.filter((s) => s.status === SessionStatus.CANCELLED);
    const cancelledByReason: Record<string, number> = {};
    for (const c of cancelled) cancelledByReason[c.cancellationReason ?? 'UNKNOWN'] = (cancelledByReason[c.cancellationReason ?? 'UNKNOWN'] ?? 0) + 1;

    const warnings: string[] = [];
    if (unresolved.length) {
      warnings.push(
        `${unresolved.length} session(s) are UNRESOLVED (${unresolved.reduce((a, s) => a + s.recordsAttached, 0)} attendance record(s) attached) and are excluded until an administrator confirms or cancels them`,
      );
    }
    const open = sessions.filter((s) => s.status === SessionStatus.OPEN).length;
    if (open) warnings.push(`${open} session(s) are still OPEN and not yet included in totals`);

    return {
      group: { id: group.id, name: group.name },
      range: { from: from ?? null, to: to ?? null },
      totals: {
        heldSessions: heldSessions.length,
        totalEligible,
        totalPresent,
        totalAbsent: totalEligible - totalPresent,
        attendanceRate: rate(totalPresent, totalEligible),
        meanSessionAttendanceRate: sessionRates.length ? Math.round((sessionRates.reduce((a, b) => a + b, 0) / sessionRates.length) * 100) / 100 : null,
        activeMembersNow: await this.prisma.groupMembership.count({
          where: { groupId, joinedAt: { lte: new Date() }, OR: [{ leftAt: null }, { leftAt: { gt: new Date() } }] },
        }),
      },
      excluded: {
        cancelled: cancelled.length,
        cancelledByReason,
        unresolved: unresolved.length,
        open,
        scheduled: sessions.filter((s) => s.status === SessionStatus.SCHEDULED).length,
      },
      warnings,
      sessions,
    };
  }

  groupTable(r: Awaited<ReturnType<ReportsService['groupReport']>>): ReportTable {
    return {
      title: `group-sessions-${r.group.name}`,
      columns: [
        { key: 'occurrenceDate', header: 'Date' },
        { key: 'title', header: 'Session' },
        { key: 'status', header: 'Status' },
        { key: 'cancellationReason', header: 'Cancellation reason' },
        { key: 'countsTowardStatistics', header: 'Counts toward statistics' },
        { key: 'eligible', header: 'Eligible' },
        { key: 'present', header: 'Present' },
        { key: 'absent', header: 'Absent' },
        { key: 'attendanceRate', header: 'Attendance %' },
      ],
      rows: r.sessions,
    };
  }

  /** Per-member statistics for a group over a date range (held sessions the member was eligible for). */
  async groupMembersReport(groupId: string, scope: AccessScope, from?: string, to?: string) {
    const group = await this.loadGroup(groupId, scope);
    const rows = await this.prisma.$queryRaw<{ memberId: string; fullName: string; stateCode: string; eligible: bigint; present: bigint }[]>`
      SELECT m.id AS "memberId", m."fullName", m."stateCode",
             count(*) AS eligible,
             count(r.id) AS present
      FROM "AttendanceSession" s
      JOIN "GroupMembership" gm ON gm."groupId" = s."groupId" AND ${ELIGIBLE}
      JOIN "Member" m ON m.id = gm."memberId"
      LEFT JOIN "AttendanceRecord" r ON r."sessionId" = s.id AND r."memberId" = m.id AND r.status = 'PRESENT'
      WHERE s."groupId" = ${groupId}::uuid
        AND s.status = 'CLOSED'
        AND s."occurrenceDate" BETWEEN ${from ?? MIN_DATE}::date AND ${to ?? MAX_DATE}::date
      GROUP BY m.id, m."fullName", m."stateCode"
      ORDER BY m."fullName", m."stateCode"`;
    return {
      group: { id: group.id, name: group.name },
      range: { from: from ?? null, to: to ?? null },
      members: rows.map((r) => {
        const eligible = n(r.eligible);
        const present = n(r.present);
        return { memberId: r.memberId, fullName: r.fullName, stateCode: r.stateCode, eligibleSessions: eligible, present, absent: eligible - present, attendanceRate: rate(present, eligible) };
      }),
    };
  }

  groupMembersTable(r: Awaited<ReturnType<ReportsService['groupMembersReport']>>): ReportTable {
    return {
      title: `group-members-${r.group.name}`,
      columns: [
        { key: 'stateCode', header: 'State code' },
        { key: 'fullName', header: 'Full name' },
        { key: 'eligibleSessions', header: 'Eligible sessions' },
        { key: 'present', header: 'Present' },
        { key: 'absent', header: 'Absent' },
        { key: 'attendanceRate', header: 'Attendance %' },
      ],
      rows: r.members,
    };
  }

  // ───────────── Member ─────────────

  /**
   * Every session the member was eligible for (across all their memberships), with participation.
   * The attendance rate uses only held sessions they were eligible for — a member who joined
   * after session 4 of 10 and attended 5 of sessions 5–10 scores 5/6 = 83.33 %.
   */
  async memberReport(memberId: string, scope: AccessScope, from?: string, to?: string) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId }, include: { memberships: true } });
    if (!member) throw AppError.notFound('Member');
    if (!scope.all && !member.memberships.some((m) => scope.canAccess(m.groupId))) throw AppError.notFound('Member');

    const rows = await this.prisma.$queryRaw<
      { sessionId: string; groupId: string; groupName: string; membershipId: string; occurrenceDate: Date; title: string; status: SessionStatus; plannedStart: Date; recordStatus: string | null; capturedAt: Date | null }[]
    >`
      SELECT s.id AS "sessionId", s."groupId", g.name AS "groupName", gm.id AS "membershipId",
             s."occurrenceDate", s.title, s.status, s."plannedStart",
             r.status::text AS "recordStatus", r."capturedAt"
      FROM "GroupMembership" gm
      JOIN "AttendanceSession" s ON s."groupId" = gm."groupId" AND ${ELIGIBLE}
      JOIN "CdsGroup" g ON g.id = s."groupId"
      LEFT JOIN "AttendanceRecord" r ON r."sessionId" = s.id AND r."memberId" = gm."memberId"
      WHERE gm."memberId" = ${memberId}::uuid
        AND s."occurrenceDate" BETWEEN ${from ?? MIN_DATE}::date AND ${to ?? MAX_DATE}::date
      ORDER BY s."plannedStart"`;

    const sessions = rows
      .filter((r) => scope.canAccess(r.groupId))
      .map((r) => {
        const isPresent = r.recordStatus === 'PRESENT';
        let participation: Participation;
        switch (r.status) {
          case SessionStatus.CLOSED:
          case SessionStatus.OPEN:
            participation = isPresent ? 'PRESENT' : 'ABSENT';
            break;
          case SessionStatus.CANCELLED:
            participation = 'CANCELLED';
            break;
          case SessionStatus.UNRESOLVED:
            participation = 'PENDING_RESOLUTION';
            break;
          default:
            participation = r.plannedStart > new Date() ? 'UPCOMING' : 'PENDING_RESOLUTION';
        }
        return {
          sessionId: r.sessionId,
          groupId: r.groupId,
          groupName: r.groupName,
          membershipId: r.membershipId,
          occurrenceDate: fromDateOnly(r.occurrenceDate),
          title: r.title,
          sessionStatus: r.status,
          countsTowardStatistics: r.status === SessionStatus.CLOSED,
          participation,
          recordedPresent: isPresent,
          capturedAt: r.capturedAt,
        };
      });

    const counted = sessions.filter((s) => s.countsTowardStatistics);
    const present = counted.filter((s) => s.recordedPresent).length;
    const byMembership = member.memberships
      .filter((m) => scope.canAccess(m.groupId))
      .map((m) => {
        const mine = counted.filter((s) => s.membershipId === m.id);
        const p = mine.filter((s) => s.recordedPresent).length;
        return { membershipId: m.id, groupId: m.groupId, joinedAt: m.joinedAt, leftAt: m.leftAt, eligibleSessions: mine.length, present: p, absent: mine.length - p, attendanceRate: rate(p, mine.length) };
      });

    return {
      member: { id: member.id, fullName: member.fullName, stateCode: member.stateCode, status: member.status },
      range: { from: from ?? null, to: to ?? null },
      summary: {
        eligibleSessions: counted.length,
        present,
        absent: counted.length - present,
        attendanceRate: rate(present, counted.length),
        pendingResolution: sessions.filter((s) => s.participation === 'PENDING_RESOLUTION').length,
        cancelledSessions: sessions.filter((s) => s.participation === 'CANCELLED').length,
        upcoming: sessions.filter((s) => s.participation === 'UPCOMING').length,
      },
      byMembership,
      sessions,
    };
  }

  memberTable(r: Awaited<ReturnType<ReportsService['memberReport']>>): ReportTable {
    return {
      title: `member-${r.member.stateCode}`,
      columns: [
        { key: 'occurrenceDate', header: 'Date' },
        { key: 'groupName', header: 'Group' },
        { key: 'title', header: 'Session' },
        { key: 'sessionStatus', header: 'Session status' },
        { key: 'participation', header: 'Participation' },
        { key: 'capturedAt', header: 'Recorded at (UTC)' },
      ],
      rows: r.sessions,
    };
  }

  private async loadGroup(groupId: string, scope: AccessScope) {
    scope.assertGroup(groupId);
    const group = await this.prisma.cdsGroup.findUnique({ where: { id: groupId } });
    if (!group) throw AppError.notFound('Group');
    return group;
  }
}
