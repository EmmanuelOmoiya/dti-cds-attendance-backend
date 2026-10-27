import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { ScheduleStatus } from '../generated/prisma/client';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateScheduleDto {
  @IsUUID()
  groupId: string;

  @IsString() @MinLength(2) @MaxLength(120)
  title: string;

  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  @IsInt() @Min(1) @Max(7)
  dayOfWeek: number;

  /** Local wall-clock time "HH:mm". */
  @Matches(TIME, { message: 'startLocalTime must be HH:mm' })
  startLocalTime: string;

  @Matches(TIME, { message: 'endLocalTime must be HH:mm' })
  endLocalTime: string;

  /** IANA timezone, e.g. Africa/Lagos. Defaults to APP_TIMEZONE. */
  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;

  /** First local date the schedule applies (YYYY-MM-DD). */
  @Matches(DATE)
  effectiveFrom: string;

  /** Last local date the schedule applies (inclusive); omit for open-ended. */
  @IsOptional() @Matches(DATE)
  effectiveUntil?: string;

  /**
   * Also generate occurrences between effectiveFrom and today. Past occurrences start as
   * UNRESOLVED (or SCHEDULED within the resolution grace) — they still need an admin to confirm or cancel.
   */
  @IsOptional() @IsBoolean()
  backfillPast?: boolean;
}

export class UpdateScheduleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  title?: string;
}

export class EndScheduleDto {
  /** Last date (inclusive) on which the schedule applies. */
  @Matches(DATE)
  effectiveUntil: string;
}

export class ScheduleQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  groupId?: string;

  @IsOptional() @IsEnum(ScheduleStatus)
  status?: ScheduleStatus;
}

export class PreviewQueryDto {
  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;
}

export class GenerateQueryDto {
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  backfillPast?: boolean;
}
