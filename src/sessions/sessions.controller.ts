import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AttendanceService } from '../attendance/attendance.service';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { RejectReason } from '../generated/prisma/client';
import { ReportsService } from '../reports/reports.service';
import {
  CancelSessionDto,
  ConfirmHeldDto,
  CreateSessionDto,
  ReinstateSessionDto,
  SessionAttendanceQueryDto,
  SessionQueryDto,
  UpdateSessionDto,
} from './sessions.dto';
import { SessionsService } from './sessions.service';

@ApiTags('Sessions')
@ApiBearerAuth()
@Controller({ path: 'sessions', version: '1' })
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly reports: ReportsService,
    private readonly attendance: AttendanceService,
  ) {}

  @Get()
  @RequirePermissions(Permission.SESSIONS_READ)
  list(@Query() q: SessionQueryDto, @CurrentUser() user: UserActor) {
    return this.sessions.list(q, user.scope);
  }

  /** Ad-hoc session for a meeting outside the recurring schedule. */
  @Post()
  @RequirePermissions(Permission.SESSIONS_WRITE)
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: UserActor) {
    return this.sessions.create(dto, user);
  }

  @Get(':id')
  @RequirePermissions(Permission.SESSIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.sessions.get(id, user.scope);
  }

  /** Rename, or reschedule this single occurrence (SCHEDULED sessions without attendance only). */
  @Patch(':id')
  @RequirePermissions(Permission.SESSIONS_WRITE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSessionDto, @CurrentUser() user: UserActor) {
    return this.sessions.update(id, dto, user);
  }

  /** Meeting is happening now (confirms it was held). Allowed around the planned time only. */
  @Post(':id/open')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SESSIONS_WRITE)
  open(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.sessions.open(id, user);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SESSIONS_WRITE)
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.sessions.close(id, user);
  }

  /** Resolve a past SCHEDULED/UNRESOLVED session as held. */
  @Post(':id/confirm-held')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SESSIONS_WRITE)
  confirmHeld(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmHeldDto, @CurrentUser() user: UserActor) {
    return this.sessions.confirmHeld(id, dto, user);
  }

  /** The meeting did not happen. Reason required; existing attendance must be explicitly voided. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SESSIONS_WRITE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelSessionDto, @CurrentUser() user: UserActor) {
    return this.sessions.cancel(id, dto, user);
  }

  /** Undo a cancellation; optionally re-evaluate taps that were rejected because it was cancelled. */
  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SESSIONS_WRITE)
  async reinstate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReinstateSessionDto, @CurrentUser() user: UserActor) {
    const session = await this.sessions.reinstate(id, dto.note, user);
    if (!dto.reprocessRejectedEvents) return session;
    const reprocessing = await this.attendance.reprocess({ sessionId: id, reason: RejectReason.SESSION_CANCELLED }, user);
    return { ...session, reprocessing };
  }

  /** Eligible members with PRESENT / ABSENT (absent only once the meeting is confirmed held). */
  @Get(':id/attendance')
  @RequirePermissions(Permission.ATTENDANCE_READ)
  async attendanceList(@Param('id', ParseUUIDPipe) id: string, @Query() q: SessionAttendanceQueryDto, @CurrentUser() user: UserActor) {
    const r = await this.reports.sessionReport(id, user.scope);
    const state = q.state ?? 'all';
    const members =
      state === 'present' ? r.members.filter((m) => m.participation === 'PRESENT') : state === 'absent' ? r.members.filter((m) => m.participation === 'ABSENT') : r.members;
    return { session: r.session, summary: r.summary, members };
  }

  @Get(':id/statistics')
  @RequirePermissions(Permission.ATTENDANCE_READ)
  async statistics(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    const r = await this.reports.sessionReport(id, user.scope);
    const events = await this.sessions.get(id, user.scope);
    return { session: r.session, ...r.summary, deviceEvents: events.attendanceSummary.deviceEvents, voidedRecords: events.attendanceSummary.voided };
  }
}
