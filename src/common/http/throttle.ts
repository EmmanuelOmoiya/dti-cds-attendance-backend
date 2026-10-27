
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

/**
 * Per-route limit (requests per 60 s), read from the environment when the route is hit, so
 * limits are configurable without code changes. Values are validated at boot by AppConfig.
 */
export function perMinute(envKey: string, fallback: number) {
  return {
    ttl: 60_000,
    limit: () => {
      const v = Number(process.env[envKey]);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    },
  };
}

interface StorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed throttler storage so limits hold across API instances and restarts.
 * Fixed window per key; an atomic Lua script increments and sets expiry in one round trip.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private static readonly SCRIPT = `
    local hits = redis.call('INCR', KEYS[1])
    if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
    local ttl = redis.call('PTTL', KEYS[1])
    local blocked = redis.call('PTTL', KEYS[2])
    if hits > tonumber(ARGV[2]) and blocked <= 0 and tonumber(ARGV[3]) > 0 then
      redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
      blocked = tonumber(ARGV[3])
    end
    return { hits, ttl, blocked }
  `;

  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<StorageRecord> {
    const k = `throttle:${throttlerName}:${key}`;
    const [hits, ttlMs, blockedMs] = (await this.redis.eval(
      RedisThrottlerStorage.SCRIPT,
      2,
      `${k}:hits`,
      `${k}:blocked`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number];
    const isBlocked = blockedMs > 0 || hits > limit;
    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
      isBlocked,
      timeToBlockExpire: Math.max(0, Math.ceil((blockedMs > 0 ? blockedMs : ttlMs) / 1000)),
    };
  }
}
