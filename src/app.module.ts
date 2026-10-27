import { Module, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthedRequest } from './auth/decorators';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { CardsModule } from './cards/cards.module';
import { perMinute, RedisThrottlerStorage } from './common/http/throttle';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis.module';
import { AppConfig, AppConfigModule } from './config/config.module';
import { DevicesModule } from './devices/devices.module';
import { GroupsModule } from './groups/groups.module';
import { HealthController, REDIS_CLIENT } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { MembersModule } from './members/members.module';
import { ReportsModule } from './reports/reports.module';
import { SchedulesModule } from './schedules/schedules.module';
import { SessionsModule } from './sessions/sessions.module';
import { SynchronizationModule } from './synchronization/synchronization.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // Named wildcard (path-to-regexp v8 syntax used by NestJS 11).
        forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
        pinoHttp: {
          level: config.LOG_LEVEL,
          // Request id is assigned by requestContextMiddleware (honours X-Request-Id).
          genReqId: (req) => (req as unknown as { id: string }).id,
          autoLogging: { ignore: (req) => (req.url ?? '').includes('/health') },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.secret', '*.refreshToken', '*.accessToken'],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          customProps: (req) => {
            const actor = (req as unknown as AuthedRequest).actor;
            return actor?.type === 'DEVICE' ? { deviceId: actor.id } : actor?.type === 'USER' ? { userId: actor.id } : {};
          },
          customSuccessMessage: (req, res, responseTime) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(responseTime)}ms`,
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null) => ({
        throttlers: [{ name: 'default', ...perMinute('THROTTLE_DEFAULT_PER_MINUTE', 300) }],
        storage: redis ? new RedisThrottlerStorage(redis) : undefined,
        errorMessage: 'Too many requests',
      }),
    }),
    AuditModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    SchedulesModule,
    SessionsModule,
    MembersModule,
    CardsModule,
    AttendanceModule,
    DevicesModule,
    SynchronizationModule,
    ReportsModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit → authenticate → authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
