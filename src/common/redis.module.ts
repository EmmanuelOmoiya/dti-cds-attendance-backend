import { Global, Inject, Logger, Module, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/config.module';
import { REDIS_CLIENT } from '../health/health.controller';

/**
 * Redis is used for one thing in the MVP: shared rate-limit counters (correct across instances
 * and restarts). It is optional — without REDIS_URL, rate limiting falls back to in-memory.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfig],
      useFactory: (config: AppConfig): Redis | null => {
        if (!config.REDIS_URL) return null;
        const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
        client.on('error', (e) => new Logger('Redis').warn(`Redis error: ${e.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }
}
