import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppConfig } from '../config/config.module';
import { SchedulesService } from '../schedules/schedules.service';
import { SessionsService } from '../sessions/sessions.service';

/** Arbitrary constant identifying the session-maintenance advisory lock. */
const LOCK_KEY = 4_242_001;

export interface MaintenanceResult {
  ran: boolean;
  generated: number;
  markedUnresolved: number;
  autoClosed: number;
  durationMs: number;
}

/**
 * Periodic session maintenance (no business logic of its own — it calls the services):
 *   1. generate expected sessions from active schedules up to the horizon
 *   2. auto-close OPEN sessions past plannedEnd + close grace
 *   3. mark SCHEDULED sessions UNRESOLVED 24 h (configurable) after plannedEnd — never CANCELLED
 *
 * All steps are idempotent. A transaction-scoped Postgres advisory lock ensures only one API
 * instance runs them at a time; a skipped run is simply caught up by the next tick.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
    private readonly sessions: SessionsService,
    private readonly config: AppConfig,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.JOBS_ENABLED) return;
    const job = CronJob.from({
      cronTime: this.config.JOBS_CRON,
      onTick: () => void this.runMaintenance(),
      start: true,
    });
    this.registry.addCronJob('session-maintenance', job);
    // Catch up immediately on boot (e.g. after downtime).
    void this.runMaintenance();
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('cron', 'session-maintenance')) this.registry.deleteCronJob('session-maintenance');
  }

  async runMaintenance(now = new Date()): Promise<MaintenanceResult> {
    const started = Date.now();
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
          if (!locked) return { ran: false, generated: 0, markedUnresolved: 0, autoClosed: 0 };
          const generation = await this.schedules.generateAll(now, tx);
          const autoClosed = await this.sessions.autoClose(now, tx);
          const markedUnresolved = await this.sessions.markUnresolved(now, tx);
          return { ran: true, generated: generation.reduce((a, g) => a + g.created, 0), markedUnresolved, autoClosed };
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      const out = { ...result, durationMs: Date.now() - started };
      this.logger.log({ job: 'session-maintenance', ...out }, 'Session maintenance finished');
      return out;
    } catch (err) {
      this.logger.error({ job: 'session-maintenance', err: err instanceof Error ? err.message : String(err) }, 'Session maintenance failed');
      return { ran: false, generated: 0, markedUnresolved: 0, autoClosed: 0, durationMs: Date.now() - started };
    }
  }
}
