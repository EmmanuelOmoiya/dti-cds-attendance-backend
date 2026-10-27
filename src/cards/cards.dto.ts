import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { AssignmentEndReason, CardRevokeReason, CardStatus } from '../generated/prisma/client';

export class RegisterCardDto {
  /** Card UID as read by the reader: hex, separators (':' '-' ' ') allowed, case-insensitive. */
  @IsString() @MinLength(8) @MaxLength(64)
  cardUid: string;

  /** Optional printed serial / sticker label. */
  @IsOptional() @IsString() @MaxLength(64)
  label?: string;
}

export class RevokeCardDto {
  @IsEnum(CardRevokeReason)
  reason: CardRevokeReason;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class CardQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(CardStatus)
  status?: CardStatus;

  /** Exact UID (any formatting). */
  @IsOptional() @IsString() @MaxLength(64)
  cardUid?: string;

  /** Cards ever assigned to this member. */
  @IsOptional() @IsUUID()
  memberId?: string;
}

export class CardHistoryQueryDto {
  @IsString() @MinLength(8) @MaxLength(64)
  cardUid: string;
}

export class AssignCardDto {
  /** Either cardId or cardUid (an unknown UID is registered on the fly). */
  @ValidateIf((o: AssignCardDto) => !o.cardUid) @IsUUID()
  cardId?: string;

  @ValidateIf((o: AssignCardDto) => !o.cardId) @IsString() @MinLength(8) @MaxLength(64)
  cardUid?: string;

  @IsUUID()
  memberId: string;

  /** When the member received the card (≤ now). Defaults to now. Back-dating is audited. */
  @IsOptional() @IsISO8601({ strict: true })
  assignedAt?: string;
}

export const USER_ASSIGNMENT_END_REASONS = [
  AssignmentEndReason.RETURNED,
  AssignmentEndReason.LOST,
  AssignmentEndReason.DAMAGED,
  AssignmentEndReason.STOLEN,
  AssignmentEndReason.MEMBER_LEFT,
  AssignmentEndReason.REVOKED,
  AssignmentEndReason.OTHER,
] as const;

export class EndAssignmentDto {
  @IsIn(USER_ASSIGNMENT_END_REASONS)
  reason: AssignmentEndReason;

  /** Defaults to now; must be after assignedAt and not in the future. */
  @IsOptional() @IsISO8601({ strict: true })
  endedAt?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class ReplaceCardDto {
  @ValidateIf((o: ReplaceCardDto) => !o.newCardUid) @IsUUID()
  newCardId?: string;

  @ValidateIf((o: ReplaceCardDto) => !o.newCardId) @IsString() @MinLength(8) @MaxLength(64)
  newCardUid?: string;

  /** Why the old card is being replaced; LOST/DAMAGED/STOLEN also revoke the old card. */
  @IsIn(['LOST', 'DAMAGED', 'STOLEN', 'OTHER'])
  reason: 'LOST' | 'DAMAGED' | 'STOLEN' | 'OTHER';

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

export class AssignmentQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  memberId?: string;

  @IsOptional() @IsUUID()
  cardId?: string;

  @IsOptional() @IsIn(['ACTIVE', 'ENDED'])
  status?: 'ACTIVE' | 'ENDED';

  /** Assignments valid at this instant. */
  @IsOptional() @IsISO8601({ strict: true })
  activeAt?: string;
}
