import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { MemberStatus, MembershipEndReason } from '../generated/prisma/client';

/** NYSC state codes look like LA/24A/1234; accepted loosely (letters, digits, '/', '-'). */
const STATE_CODE = /^[A-Za-z0-9][A-Za-z0-9/ -]{2,30}$/;

export class CreateMemberDto {
  @IsString() @MinLength(2) @MaxLength(120)
  fullName: string;

  @Matches(STATE_CODE, { message: 'stateCode has an invalid format' })
  stateCode: string;

  /** Initial CDS group. */
  @IsUUID()
  groupId: string;

  /** When the membership starts (ISO instant). Defaults to now. */
  @IsOptional() @IsISO8601({ strict: true })
  joinedAt?: string;
}

export class UpdateMemberDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  fullName?: string;

  @IsOptional() @Matches(STATE_CODE, { message: 'stateCode has an invalid format' })
  stateCode?: string;
}

export class DeactivateMemberDto {
  /** When the deactivation takes effect (≤ now). Defaults to now. */
  @IsOptional() @IsISO8601({ strict: true })
  effectiveAt?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class TransferMemberDto {
  @IsUUID()
  toGroupId: string;

  /** When the member moves (old membership ends, new one starts). Defaults to now. */
  @IsOptional() @IsISO8601({ strict: true })
  effectiveAt?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class MemberQueryDto extends PageQueryDto {
  /** Name or state code (case-insensitive substring). */
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @IsOptional() @IsEnum(MemberStatus)
  status?: MemberStatus;

  /** Restrict to members of this group (see `membership`). */
  @IsOptional() @IsUUID()
  groupId?: string;

  /** With groupId: `current` (default) = membership covering `activeAt`; `any` = any membership ever. */
  @IsOptional() @IsIn(['current', 'any'])
  membership?: 'current' | 'any';

  /** Instant used for `membership=current` (defaults to now). */
  @IsOptional() @IsISO8601({ strict: true })
  activeAt?: string;
}

// ───────────── Memberships ─────────────

export class CreateMembershipDto {
  @IsUUID()
  memberId: string;

  @IsUUID()
  groupId: string;

  @IsISO8601({ strict: true })
  joinedAt: string;
}

export const USER_END_REASONS = Object.values(MembershipEndReason).filter(
  (r) => r !== MembershipEndReason.MEMBER_DEACTIVATED && r !== MembershipEndReason.TRANSFERRED,
);

export class EndMembershipDto {
  /** Exclusive end instant of the membership: sessions starting at or after this are not eligible. */
  @IsOptional() @IsISO8601({ strict: true })
  leftAt?: string;

  @IsIn(USER_END_REASONS)
  reason: MembershipEndReason;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class CorrectMembershipDto {
  @IsOptional() @IsISO8601({ strict: true })
  joinedAt?: string;

  /** New end instant, or null to re-open an ended membership. Omit to leave unchanged. */
  @IsOptional() @ValidateIf((o: CorrectMembershipDto) => o.leftAt !== null) @IsISO8601({ strict: true })
  leftAt?: string | null;

  /** Why the historical data is being corrected (required). */
  @IsString() @MinLength(3) @MaxLength(1000)
  note: string;
}

export class MembershipQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  memberId?: string;

  @IsOptional() @IsUUID()
  groupId?: string;

  /** Only memberships valid at this instant. */
  @IsOptional() @IsISO8601({ strict: true })
  activeAt?: string;
}
