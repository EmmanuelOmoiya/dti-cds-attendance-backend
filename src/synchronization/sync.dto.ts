import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DEVICE_IDENTIFIER } from '../devices/devices.dto';

export class DeviceTokenRequestDto {
  @Matches(DEVICE_IDENTIFIER)
  deviceIdentifier: string;

  @IsString() @MinLength(16) @MaxLength(200)
  secret: string;
}

export class UploadEventDto {
  /** Stable id generated on the device when the tap is captured (idempotency key). */
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'clientEventId must be 1–64 chars of letters, digits, _ or -' })
  clientEventId: string;

  /** UID read from the card (hex). Unknown or malformed UIDs are stored and rejected, not dropped. */
  @IsString() @MinLength(1) @MaxLength(64)
  cardUid: string;

  /** Device clock at the moment of the tap (ISO-8601 with offset). Business rules use this time. */
  @IsISO8601({ strict: true })
  capturedAt: string;

  /** Session the device attributed the tap to (optional; the server resolves by time otherwise). */
  @IsOptional() @IsString() @MaxLength(64)
  sessionId?: string;
}

export class UploadBatchDto {
  /** Device-generated batch id, for tracing only (idempotency is per event). */
  @IsString() @MinLength(1) @MaxLength(64)
  batchId: string;

  /** Device clock when sending — used to estimate clock skew. */
  @IsOptional() @IsISO8601({ strict: true })
  deviceTime?: string;

  /** ETag of the roster snapshot the device was using. */
  @IsOptional() @IsString() @MaxLength(128)
  snapshotVersion?: string;

  /** Max size is SYNC_MAX_BATCH_SIZE (checked by the service; 413 when exceeded). */
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => UploadEventDto)
  events: UploadEventDto[];
}

export class HeartbeatDto {
  @IsOptional() @IsISO8601({ strict: true })
  deviceTime?: string;

  @IsOptional() @IsString() @MaxLength(64)
  firmwareVersion?: string;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  batteryPct?: number;

  /** Taps captured locally but not yet acknowledged by the server. */
  @IsOptional() @IsInt() @Min(0)
  pendingEvents?: number;

  @IsOptional() @IsISO8601({ strict: true })
  lastCaptureAt?: string;

  /** Changes on every device boot (helps detect restarts). */
  @IsOptional() @IsString() @MaxLength(64)
  bootId?: string;

  @IsOptional() @IsString() @MaxLength(64)
  snapshotVersion?: string;
}
