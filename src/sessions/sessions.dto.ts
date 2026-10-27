import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { CancellationReason, SessionOrigin, SessionStatus } from '../generated/prisma/client';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toBool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

/** Reasons an administrator may give (SCHEDULE_CHANGED is reserved for the system). */
export const USER_CANCELLATION_REASONS = Object.values(CancellationReason).filter((r) => r !== CancellationReason.SCHEDULE_CHANGED);

export class CreateSessionDto {
  @IsUUID()
  groupId: string;

  @IsString() @MinLength(2) @MaxLength(120)
  title: string;

  /** ISO-8601 instant, e.g. 2026-11-13T09:00:00+01:00 */
  @IsISO8601({ strict: true })
  plannedStart: string;

  @IsISO8601({ strict: true })
  plannedEnd: string;

  /** IANA timezone used to derive the session's local date. Defaults to APP_TIMEZONE. */
  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;
}

export class UpdateSessionDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  title?: string;

  @IsOptional() @IsISO8601({ strict: true })
  plannedStart?: string;

  @IsOptional() @IsISO8601({ strict: true })
  plannedEnd?: string;
}

export class ConfirmHeldDto {
  /** Actual start; defaults to plannedStart. */
  @IsOptional() @IsISO8601({ strict: true })
  openedAt?: string;

  /** Actual end of attendance-taking; defaults to plannedEnd + close grace. */
  @IsOptional() @IsISO8601({ strict: true })
  closedAt?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class CancelSessionDto {
  @IsIn(USER_CANCELLATION_REASONS)
  reason: CancellationReason;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;

  /** Required when the session already has PRESENT records: voids them (restorable by reinstate). */
  @IsOptional() @IsBoolean()
  voidExistingAttendance?: boolean;
}

export class ReinstateSessionDto {
  @IsString() @MinLength(3) @MaxLength(1000)
  note: string;

  /** Also re-evaluate device taps that were rejected because the session was cancelled. */
  @IsOptional() @IsBoolean()
  reprocessRejectedEvents?: boolean;
}

export class SessionQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  groupId?: string;

  @IsOptional() @IsEnum(SessionStatus)
  status?: SessionStatus;

  @IsOptional() @IsEnum(SessionOrigin)
  origin?: SessionOrigin;

  @IsOptional() @IsUUID()
  scheduleId?: string;

  /** Inclusive local date range on occurrenceDate (YYYY-MM-DD). */
  @IsOptional() @Matches(DATE)
  from?: string;

  @IsOptional() @Matches(DATE)
  to?: string;

  /** Shortcut for status=UNRESOLVED. */
  @IsOptional() @Transform(toBool) @IsBoolean()
  needsResolution?: boolean;
}

export class SessionAttendanceQueryDto {
  @IsOptional() @IsIn(['present', 'absent', 'all'])
  state?: 'present' | 'absent' | 'all';
}
