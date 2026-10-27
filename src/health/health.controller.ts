import { Controller, Get, HttpStatus, Inject, Optional, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import Redis from 'ioredis';
import { Public } from '../auth/decorators';
import { PrismaService } from '../common/prisma/prisma.service';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /** Liveness: the process is up. */
  @Get()
  live() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  /** Readiness: dependencies reachable (PostgreSQL, and Redis when configured). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, 'up' | 'down' | 'not_configured'> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }
    if (this.redis) {
      try {
        checks.redis = (await this.redis.ping()) === 'PONG' ? 'up' : 'down';
      } catch {
        checks.redis = 'down';
      }
    } else {
      checks.redis = 'not_configured';
    }
    const ok = Object.values(checks).every((v) => v !== 'down');
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
