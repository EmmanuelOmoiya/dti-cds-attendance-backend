import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { IANAZone } from 'luxon';

const toInt = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : Number(value));
const toBool = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : value === true || value === 'true' || value === '1';

/**
 * Every environment variable the application reads, validated at startup.
 * Defaults are suitable for local development; production must override secrets.
 */
export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Transform(toInt) @IsInt() @Min(1) @Max(65535)
  PORT = 3000;

  @IsString() @Matches(/^postgres(ql)?:\/\//)
  DATABASE_URL!: string;

  /** Optional. When set, rate-limit counters are stored in Redis (required for multi-instance). */
  @IsOptional() @IsString() @Matches(/^rediss?:\/\//)
  REDIS_URL?: string;

  @IsString() @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @Transform(toInt) @IsInt() @Min(60)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Transform(toInt) @IsInt() @Min(1)
  REFRESH_TOKEN_TTL_DAYS = 7;

  @IsString() @MinLength(32)
  DEVICE_JWT_SECRET!: string;

  @Transform(toInt) @IsInt() @Min(60)
  DEVICE_TOKEN_TTL_SECONDS = 3600;

  /** Comma-separated list of allowed dashboard origins; empty = CORS disabled. */
  @IsOptional() @IsString()
  CORS_ORIGINS?: string;

  @Transform(toBool) @IsBoolean()
  SWAGGER_ENABLED = true;

  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL = 'info';

  /** Number of reverse proxies in front of the API (for correct client IPs). */
  @Transform(toInt) @IsInt() @Min(0)
  TRUST_PROXY_HOPS = 0;

  @IsString()
  APP_TIMEZONE = 'Africa/Lagos';

  // ── Sessions ──
  @Transform(toInt) @IsInt() @Min(1) @Max(52)
  SESSION_GENERATION_HORIZON_WEEKS = 6;

  /** Taps up to this many minutes before plannedStart count for the session. */
  @Transform(toInt) @IsInt() @Min(0) @Max(720)
  SESSION_EARLY_GRACE_MINUTES = 60;

  /** Attendance closes this many minutes after plannedEnd (auto-close point). */
  @Transform(toInt) @IsInt() @Min(0) @Max(720)
  SESSION_CLOSE_GRACE_MINUTES = 30;

  /** A SCHEDULED session becomes UNRESOLVED this many hours after plannedEnd. */
  @Transform(toInt) @IsInt() @Min(1)
  SESSION_UNRESOLVED_AFTER_HOURS = 24;

  // ── Jobs ──
  @Transform(toBool) @IsBoolean()
  JOBS_ENABLED = true;

  @IsString()
  JOBS_CRON = '*/15 * * * *';

  // ── Sync ──
  @Transform(toInt) @IsInt() @Min(1) @Max(1000)
  SYNC_MAX_BATCH_SIZE = 200;

  @Transform(toInt) @IsInt() @Min(1) @Max(60)
  SYNC_LOOKAHEAD_DAYS = 14;

  /** Taps stamped further than this in the future (vs. server time) are rejected. */
  @Transform(toInt) @IsInt() @Min(0)
  CAPTURE_FUTURE_TOLERANCE_SECONDS = 300;

  /** Taps before this date are rejected as a reset/garbage device clock. */
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  CAPTURE_MIN_DATE = '2024-01-01';

  // ── Rate limiting (requests per minute) ──
  @Transform(toInt) @IsInt() @Min(1)
  THROTTLE_DEFAULT_PER_MINUTE = 300;

  @Transform(toInt) @IsInt() @Min(1)
  THROTTLE_LOGIN_PER_MINUTE = 10;

  @Transform(toInt) @IsInt() @Min(1)
  THROTTLE_DEVICE_TOKEN_PER_MINUTE = 20;

  @Transform(toInt) @IsInt() @Min(1)
  THROTTLE_SYNC_PER_MINUTE = 120;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false, whitelist: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }
  if (!IANAZone.isValidZone(env.APP_TIMEZONE)) {
    throw new Error(`Invalid environment configuration:\n  APP_TIMEZONE: not a valid IANA timezone`);
  }
  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === env.DEVICE_JWT_SECRET) {
    throw new Error('JWT_ACCESS_SECRET and DEVICE_JWT_SECRET must differ in production');
  }
  return env;
}
