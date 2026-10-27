import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { AttendanceQueryDto, CreateManualAttendanceDto, EventQueryDto, NoteDto, ReprocessEventsDto } from './attendance.dto';
import { AttendanceService } from './attendance.service';

@ApiTags('Attendance')
@ApiBearerAuth()
@Controller({ path: 'attendance', version: '1' })
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** Official attendance records. */
  @Get()
  @RequirePermissions(Permission.ATTENDANCE_READ)
  list(@Query() q: AttendanceQueryDto, @CurrentUser() user: UserActor) {
    return this.attendance.list(q, user.scope);
  }

  /** Raw device taps with their acknowledgement (ACCEPTED / ALREADY_RECORDED / REJECTED + reason). */
  @Get('events')
  @RequirePermissions(Permission.ATTENDANCE_READ)
  events(@Query() q: EventQueryDto, @CurrentUser() user: UserActor) {
    return this.attendance.listEvents(q, user.scope);
  }

  /** Re-evaluate unresolved rejected taps against current data; creates REPROCESSED records where now valid. */
  @Post('events/reprocess')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ATTENDANCE_CORRECT)
  reprocess(@Body() dto: ReprocessEventsDto, @CurrentUser() user: UserActor) {
    return this.attendance.reprocess(dto, user);
  }

  @Post('events/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ATTENDANCE_CORRECT)
  dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: UserActor) {
    return this.attendance.dismiss(id, dto.note, user);
  }

  @Get(':id')
  @RequirePermissions(Permission.ATTENDANCE_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.attendance.get(id, user.scope);
  }

  /** Manual attendance (requires a note; member must be eligible; session not cancelled). */
  @Post()
  @RequirePermissions(Permission.ATTENDANCE_CORRECT)
  create(@Body() dto: CreateManualAttendanceDto, @CurrentUser() user: UserActor) {
    return this.attendance.createManual(dto, user);
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ATTENDANCE_CORRECT)
  void(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: UserActor) {
    return this.attendance.void(id, dto.note, user);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ATTENDANCE_CORRECT)
  restore(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: UserActor) {
    return this.attendance.restore(id, dto.note, user);
  }
}
