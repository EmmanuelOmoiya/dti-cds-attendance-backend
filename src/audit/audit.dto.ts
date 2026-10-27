import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';

export class AuditQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(64)
  entityType?: string;

  @IsOptional() @IsString() @MaxLength(64)
  entityId?: string;

  @IsOptional() @IsUUID()
  actorId?: string;

  /** Prefix match, e.g. `session.` or `device.revoked`. */
  @IsOptional() @IsString() @MaxLength(64)
  action?: string;

  @IsOptional() @IsUUID()
  groupId?: string;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;
}
