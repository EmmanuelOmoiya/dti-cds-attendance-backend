import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AttendanceIngestionService, TapResult } from '../attendance/attendance-ingestion.service';
import { AuditService } from '../audit/audit.service';
import { DeviceActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { sha256 } from '../common/security/crypto';
import { DAY_MS, fromDateOnly } from '../common/time/dates';
import { AppConfig } from '../config/config.module';
import { CardAssignmentStatus, MemberStatus, Prisma, SyncEventType, SyncResult } from '../generated/prisma/client';
import { admissionWindow, timingFromConfig } from '../sessions/session-timing';
import { HeartbeatDto, UploadBatchDto } from './sync.dto';

export interface Snapshot {
  snapshotVersion: string;
  serverTime: string;
  body: Record<string, unknown>;
}

/**
 * Device synchronization protocol (docs/DEVICE_SYNC.md):
 *   download  GET  /sync/snapshot             full roster + sessions; ETag / 304 when unchanged
 *   upload    POST /sync/attendance-batches   per-event acknowledgements; safe to retry
 *   status    POST /sync/heartbeat
 * Every call is recorded as a SyncEvent (counts, timing, errors) for the device's history.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: AttendanceIngestionService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async snapshot(device: DeviceActor, ifNoneMatch?: string): Promise<{ notModified: boolean; snapshot: Snapshot }> {
    const started = Date.now();
    const snapshot = await this.buildSnapshot(device);
    const notModified = !!ifNoneMatch && ifNoneMatch.replace(/^W\//, '').replace(/"/g, '') === snapshot.snapshotVersion;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now, lastSyncAt: now } }),
      this.prisma.syncEvent.create({
        data: {
          deviceId: device.id,
          type: SyncEventType.SNAPSHOT,
          result: SyncResult.SUCCESS,
          durationMs: Date.now() - started,
          metadata: { notModified, snapshotVersion: snapshot.snapshotVersion, rosterSize: (snapshot.body.roster as unknown[]).length },
        },
      }),
    ]);
    return { notModified, snapshot };
  }

  /**
   * Process an upload batch. Each tap is handled independently (own transaction), so the response
   * always carries one result per submitted tap, in submission order:
   *   ACCEPTED | ALREADY_RECORDED | REJECTED  → final; the device marks the tap synced
   *   RETRY                                   → nothing was stored for it; resend later
   */
  async uploadBatch(device: DeviceActor, dto: UploadBatchDto) {
    const started = Date.now();
    const receivedAt = new Date();
    const deviceTime = dto.deviceTime ? new Date(dto.deviceTime) : null;
    const clockSkewMs = deviceTime ? receivedAt.getTime() - deviceTime.getTime() : null;

    if (dto.events.length > this.config.SYNC_MAX_BATCH_SIZE) {
      await this.prisma.syncEvent.create({
        data: {
          deviceId: device.id,
          type: SyncEventType.UPLOAD,
          result: SyncResult.FAILED,
          batchId: dto.batchId,
          itemsReceived: dto.events.length,
          errorCode: ErrorCode.BATCH_TOO_LARGE,
          deviceTime,
          clockSkewMs: clampInt(clockSkewMs),
        },
      });
      throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.BATCH_TOO_LARGE, `A batch may contain at most ${this.config.SYNC_MAX_BATCH_SIZE} events`, {
        maxBatchSize: this.config.SYNC_MAX_BATCH_SIZE,
      });
    }

    const syncEvent = await this.prisma.syncEvent.create({
      data: {
        deviceId: device.id,
        type: SyncEventType.UPLOAD,
        result: SyncResult.FAILED, // updated below; stays FAILED if processing crashes
        batchId: dto.batchId,
        itemsReceived: dto.events.length,
        deviceTime,
        clockSkewMs: clampInt(clockSkewMs),
      },
    });

    try {
      // Process in capture order so "first tap wins" is deterministic; answer in submission order.
      const order = dto.events.map((e, i) => ({ e, i, at: new Date(e.capturedAt) })).sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
      const results: TapResult[] = new Array(dto.events.length);
      for (const { e, i, at } of order) {
        results[i] = await this.ingestion.ingest(
          { clientEventId: e.clientEventId, cardUid: e.cardUid, capturedAt: at, sessionId: e.sessionId ?? null },
          { deviceId: device.id, deviceGroupId: device.groupId, receivedAt, clockSkewMs: clampInt(clockSkewMs), syncEventId: syncEvent.id },
        );
      }

      const summary = {
        received: results.length,
        accepted: results.filter((r) => r.status === 'ACCEPTED').length,
        alreadyRecorded: results.filter((r) => r.status === 'ALREADY_RECORDED').length,
        rejected: results.filter((r) => r.status === 'REJECTED').length,
        retry: results.filter((r) => r.status === 'RETRY').length,
      };
      const rejectReasons: Record<string, number> = {};
      for (const r of results) if (r.status === 'REJECTED' && r.reasonCode) rejectReasons[r.reasonCode] = (rejectReasons[r.reasonCode] ?? 0) + 1;
      const durationMs = Date.now() - started;
      const result = summary.retry === 0 ? SyncResult.SUCCESS : summary.retry === summary.received ? SyncResult.FAILED : SyncResult.PARTIAL;

      await this.prisma.syncEvent.update({
        where: { id: syncEvent.id },
        data: {
          result,
          itemsAccepted: summary.accepted,
          itemsAlreadyRecorded: summary.alreadyRecorded,
          itemsRejected: summary.rejected,
          itemsRetry: summary.retry,
          durationMs,
          metadata: { rejectReasons, replayed: results.filter((r) => r.replayed).length },
        },
      });
      await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: receivedAt, lastSyncAt: receivedAt } });
      await this.audit.record(this.prisma, {
        actor: { type: 'DEVICE', id: device.id },
        action: 'sync.batch_processed',
        entityType: 'SyncEvent',
        entityId: syncEvent.id,
        groupId: device.groupId,
        metadata: { batchId: dto.batchId, ...summary, rejectReasons },
      });
      this.logger.log({ deviceId: device.id, batchId: dto.batchId, ...summary, rejectReasons, clockSkewMs, durationMs }, 'Attendance batch processed');

      const snapshot = await this.buildSnapshot(device);
      return {
        batchId: dto.batchId,
        serverTime: new Date().toISOString(),
        snapshotVersion: snapshot.snapshotVersion,
        results: results.map((r) => ({
          clientEventId: r.clientEventId,
          status: r.status,
          ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
          ...(r.attendanceRecordId ? { attendanceRecordId: r.attendanceRecordId } : {}),
        })),
        summary,
      };
    } catch (err) {
      await this.prisma.syncEvent
        .update({ where: { id: syncEvent.id }, data: { result: SyncResult.FAILED, errorCode: 'INTERNAL_ERROR', durationMs: Date.now() - started } })
        .catch(() => undefined);
      throw err;
    }
  }

  async heartbeat(device: DeviceActor, dto: HeartbeatDto) {
    const now = new Date();
    const deviceTime = dto.deviceTime ? new Date(dto.deviceTime) : null;
    const clockSkewMs = deviceTime ? now.getTime() - deviceTime.getTime() : null;
    const status = {
      firmwareVersion: dto.firmwareVersion ?? null,
      batteryPct: dto.batteryPct ?? null,
      pendingEvents: dto.pendingEvents ?? null,
      lastCaptureAt: dto.lastCaptureAt ?? null,
      bootId: dto.bootId ?? null,
      snapshotVersion: dto.snapshotVersion ?? null,
      deviceTime: dto.deviceTime ?? null,
      clockSkewMs,
      reportedAt: now.toISOString(),
    };
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now, lastStatus: status as Prisma.InputJsonValue } }),
      this.prisma.syncEvent.create({
        data: { deviceId: device.id, type: SyncEventType.HEARTBEAT, result: SyncResult.SUCCESS, deviceTime, clockSkewMs: clampInt(clockSkewMs), metadata: status },
      }),
    ]);
    const snapshot = await this.buildSnapshot(device);
    return { serverTime: now.toISOString(), snapshotVersion: snapshot.snapshotVersion, clockSkewMs };
  }

  /**
   * Everything a device needs to operate offline for SYNC_LOOKAHEAD_DAYS: its group, the active
   * card → member roster (with membership validity), and upcoming/recent sessions with their
   * precomputed admission windows. The version is a hash of the content, so identical data always
   * yields the same ETag.
   */
  async buildSnapshot(device: DeviceActor): Promise<Snapshot> {
    const now = new Date();
    const horizon = new Date(now.getTime() + this.config.SYNC_LOOKAHEAD_DAYS * DAY_MS);
    const since = new Date(now.getTime() - DAY_MS);
    const timing = timingFromConfig(this.config);

    const [dev, memberships, sessions] = await Promise.all([
      this.prisma.device.findUniqueOrThrow({ where: { id: device.id }, include: { group: true } }),
      this.prisma.groupMembership.findMany({
        where: {
          groupId: device.groupId,
          joinedAt: { lte: horizon },
          OR: [{ leftAt: null }, { leftAt: { gt: since } }],
          member: { status: MemberStatus.ACTIVE },
        },
        include: {
          member: {
            select: {
              id: true,
              fullName: true,
              stateCode: true,
              cardAssignments: { where: { status: CardAssignmentStatus.ACTIVE }, select: { card: { select: { cardUid: true } } } },
            },
          },
        },
      }),
      this.prisma.attendanceSession.findMany({
        where: { groupId: device.groupId, plannedEnd: { gte: since }, plannedStart: { lte: horizon } },
        orderBy: { plannedStart: 'asc' },
      }),
    ]);

    const roster = memberships
      .flatMap((m) =>
        m.member.cardAssignments.map((a) => ({
          cardUid: a.card.cardUid,
          memberId: m.member.id,
          displayName: m.member.fullName,
          stateCode: m.member.stateCode,
          eligibleFrom: m.joinedAt.toISOString(),
          eligibleUntil: m.leftAt?.toISOString() ?? null,
        })),
      )
      .sort((a, b) => a.cardUid.localeCompare(b.cardUid) || a.eligibleFrom.localeCompare(b.eligibleFrom));

    const body = {
      device: { id: dev.id, deviceIdentifier: dev.deviceIdentifier, name: dev.name, status: dev.status },
      group: { id: dev.group.id, name: dev.group.name, status: dev.group.status },
      config: {
        maxBatchSize: this.config.SYNC_MAX_BATCH_SIZE,
        recommendedSyncIntervalSec: 300,
        sessionEarlyGraceMinutes: timing.earlyGraceMinutes,
        sessionCloseGraceMinutes: timing.closeGraceMinutes,
        captureFutureToleranceSeconds: this.config.CAPTURE_FUTURE_TOLERANCE_SECONDS,
      },
      roster,
      sessions: sessions.map((s) => {
        const w = admissionWindow(s, timing);
        return {
          id: s.id,
          title: s.title,
          occurrenceDate: fromDateOnly(s.occurrenceDate),
          timezone: s.timezone,
          plannedStart: s.plannedStart.toISOString(),
          plannedEnd: s.plannedEnd.toISOString(),
          windowStart: w.start.toISOString(),
          windowEnd: w.end.toISOString(),
          status: s.status,
        };
      }),
    };
    const snapshotVersion = sha256(JSON.stringify(body)).slice(0, 32);
    return { snapshotVersion, serverTime: now.toISOString(), body };
  }
}

function clampInt(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(v)));
}
