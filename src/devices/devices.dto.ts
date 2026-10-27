import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { DeviceStatus, SyncEventType } from '../generated/prisma/client';

export const DEVICE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export class RegisterDeviceDto {
  /** Public identifier printed on the device, e.g. DLA-DEV-0001. Not a credential. */
  @Matches(DEVICE_IDENTIFIER, { message: 'deviceIdentifier must be 3–64 chars of letters, digits, . _ -' })
  deviceIdentifier: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name: string;

  @IsUUID()
  assignedGroupId: string;
}

export class UpdateDeviceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  /** Move the device to another group (caller needs scope on both groups). */
  @IsOptional() @IsUUID()
  assignedGroupId?: string;
}

export class DeviceStatusChangeDto {
  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string;
}

export class DeviceQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  groupId?: string;

  @IsOptional() @IsEnum(DeviceStatus)
  status?: DeviceStatus;

  @IsOptional() @IsString() @MaxLength(64)
  q?: string;
}

export class SyncEventQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(SyncEventType)
  type?: SyncEventType;
}
