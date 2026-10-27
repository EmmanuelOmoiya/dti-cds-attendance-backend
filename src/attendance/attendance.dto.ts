import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { AttendanceRecordStatus, AttendanceSource, EventAckStatus, EventResolution, RejectReason } from '../generated/prisma/client';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateManualAttendanceDto {
  @IsUUID()
  sessionId: string;

  @IsUUID()
  memberId: string;

  /** Why attendance is recorded manually (e.g. "card forgotten, verified by CDS president"). */
  @IsString() @MinLength(3) @MaxLength(1000)
  note: string;
}

export class NoteDto {
  @IsString() @MinLength(3) @MaxLength(1000)
  note: string;
}

export class AttendanceQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  sessionId?: string;

  @IsOptional() @IsUUID()
  memberId?: string;

  @IsOptional() @IsUUID()
  groupId?: string;

  @IsOptional() @IsUUID()
  deviceId?: string;

  /** Inclusive local date range on the session's occurrenceDate. */
  @IsOptional() @Matches(DATE)
  from?: string;

  @IsOptional() @Matches(DATE)
  to?: string;

  @IsOptional() @IsEnum(AttendanceSource)
  source?: AttendanceSource;

  @IsOptional() @IsEnum(AttendanceRecordStatus)
  status?: AttendanceRecordStatus;
}

export class EventQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(EventAckStatus)
  ackStatus?: EventAckStatus;

  @IsOptional() @IsEnum(RejectReason)
  reason?: RejectReason;

  @IsOptional() @IsEnum(EventResolution)
  resolution?: EventResolution;

  @IsOptional() @IsUUID()
  deviceId?: string;

  @IsOptional() @IsUUID()
  sessionId?: string;

  @IsOptional() @IsUUID()
  memberId?: string;

  @IsOptional() @IsUUID()
  groupId?: string;
}

export class ReprocessEventsDto {
  /** Specific events; otherwise all unresolved REJECTED events matching the filters below. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true })
  eventIds?: string[];

  @IsOptional() @IsUUID()
  sessionId?: string;

  @IsOptional() @IsUUID()
  memberId?: string;

  @IsOptional() @IsUUID()
  deviceId?: string;

  @IsOptional() @IsEnum(RejectReason)
  reason?: RejectReason;
}
