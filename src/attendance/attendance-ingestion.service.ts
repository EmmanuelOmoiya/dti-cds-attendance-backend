import { Injectable, Logger } from '@nestjs/common';
import { isTransientTxError, isUniqueViolation } from '../common/errors/db-errors';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { maskUid, sha256 } from '../common/security/crypto';
import { DAY_MS } from '../common/time/dates';
import { AppConfig } from '../config/config.module';
import {
  AttendanceEvent,
  AttendanceSource,
  CardAssignmentStatus,
  EventAckStatus,
  RejectReason,
} from '../generated/prisma/client';
import { timingFromConfig, SessionTimingConfig } from '../sessions/session-timing';
import { tryNormalizeCardUid } from '../cards/card-uid';
import { AdmissionDecision, AdmissionFacts, evaluateAdmission, resolveSession, SessionCandidate } from './admission.policy';

export interface IncomingTap {
  clientEventId: string;
  cardUid: string;
  capturedAt: Date;
  sessionId?: string | null;
}

export interface IngestContext {
  deviceId: string;
  deviceGroupId: string;
  receivedAt: Date;
  clockSkewMs: number | null;
  syncEventId: string | null;
}

export type TapStatus = 'ACCEPTED' | 'ALREADY_RECORDED' | 'REJECTED' | 'RETRY';

export interface TapResult {
  clientEventId: string;
  status: TapStatus;
  reasonCode?: RejectReason | 'TRANSIENT_ERROR';
  attendanceRecordId?: string | null;
  replayed?: boolean;
}

const MAX_ATTEMPTS = 3;

/**
 * Turns uploaded taps into AttendanceEvents (always) and AttendanceRecords (when admitted).
 *
 * Idempotency is guaranteed by the database:
 *   UNIQUE(deviceId, clientEventId)  → a retried tap is recognised and its stored ack returned
 *   UNIQUE(sessionId, memberId)      → two devices / two taps never create two records
 * Each tap is processed in its own short transaction, so one bad tap never rolls back a batch.
 */
@Injectable()
export class AttendanceIngestionService {
  private readonly logger = new Logger(AttendanceIngestionService.name);
  private readonly timing: SessionTimingConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {
    this.timing = timingFromConfig(config);
  }

  static payloadHash(cardUid: string, capturedAt: Date, sessionId: string | null | undefined): string {
    return sha256(JSON.stringify([cardUid, capturedAt.toISOString(), sessionId ?? null]));
  }

  async ingest(tap: IncomingTap, ctx: IngestContext): Promise<TapResult> {
    const cardUid = tryNormalizeCardUid(tap.cardUid) ?? tap.cardUid.trim().toUpperCase().slice(0, 64);
    const hash = AttendanceIngestionService.payloadHash(cardUid, tap.capturedAt, tap.sessionId);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const existing = await this.prisma.attendanceEvent.findUnique({
          where: { deviceId_clientEventId: { deviceId: ctx.deviceId, clientEventId: tap.clientEventId } },
        });
        if (existing) return this.replay(existing, hash);
        return await this.prisma.$transaction((tx) => this.processNew(tx, tap, cardUid, hash, ctx));
      } catch (err) {
        // A concurrent upload of the same tap (or of the same member to the same session) won the
        // race: retrying resolves it as a replay / ALREADY_RECORDED.
        if ((isUniqueViolation(err) || isTransientTxError(err)) && attempt < MAX_ATTEMPTS) continue;
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err), deviceId: ctx.deviceId, clientEventId: tap.clientEventId, card: maskUid(cardUid) },
          'Tap ingestion failed; device will retry',
        );
        return { clientEventId: tap.clientEventId, status: 'RETRY', reasonCode: 'TRANSIENT_ERROR' };
      }
    }
    return { clientEventId: tap.clientEventId, status: 'RETRY', reasonCode: 'TRANSIENT_ERROR' };
  }

  /** The stored acknowledgement, unchanged — or DUPLICATE_EVENT if the id was reused for a different tap. */
  private replay(existing: AttendanceEvent, hash: string): TapResult {
    if (existing.payloadHash !== hash) {
      return { clientEventId: existing.clientEventId, status: 'REJECTED', reasonCode: RejectReason.DUPLICATE_EVENT, replayed: true };
    }
    return {
      clientEventId: existing.clientEventId,
      status: existing.ackStatus,
      reasonCode: existing.ackReason ?? undefined,
      attendanceRecordId: existing.attendanceRecordId,
      replayed: true,
    };
  }

  private async processNew(tx: Tx, tap: IncomingTap, cardUid: string, hash: string, ctx: IngestContext): Promise<TapResult> {
    const facts = await this.loadFacts(tx, {
      cardUid,
      capturedAt: tap.capturedAt,
      receivedAt: ctx.receivedAt,
      claimedSessionId: tap.sessionId ?? null,
      deviceGroupId: ctx.deviceGroupId,
    });
    const decision = evaluateAdmission(facts, this.timing);

    const base = {
      deviceId: ctx.deviceId,
      clientEventId: tap.clientEventId,
      payloadHash: hash,
      cardUid,
      claimedSessionId: isUuid(tap.sessionId) ? tap.sessionId : null,
      capturedAt: tap.capturedAt,
      receivedAt: ctx.receivedAt,
      clockSkewMs: ctx.clockSkewMs,
      syncEventId: ctx.syncEventId,
    };

    if (decision.decision === 'REJECT') {
      await tx.attendanceEvent.create({
        data: {
          ...base,
          ackStatus: EventAckStatus.REJECTED,
          ackReason: decision.reason,
          sessionId: decision.sessionId,
          cardId: decision.cardId,
          cardAssignmentId: decision.cardAssignmentId,
          memberId: decision.memberId,
        },
      });
      return { clientEventId: tap.clientEventId, status: 'REJECTED', reasonCode: decision.reason };
    }

    const resolved = {
      sessionId: decision.sessionId,
      cardId: decision.cardId,
      cardAssignmentId: decision.cardAssignmentId,
      memberId: decision.memberId,
      sessionReassigned: decision.sessionReassigned,
    };
    const existingRecord = await tx.attendanceRecord.findUnique({
      where: { sessionId_memberId: { sessionId: decision.sessionId, memberId: decision.memberId } },
      select: { id: true },
    });
    if (existingRecord) {
      await tx.attendanceEvent.create({
        data: { ...base, ...resolved, ackStatus: EventAckStatus.ALREADY_RECORDED, attendanceRecordId: existingRecord.id },
      });
      return { clientEventId: tap.clientEventId, status: 'ALREADY_RECORDED', attendanceRecordId: existingRecord.id };
    }

    const event = await tx.attendanceEvent.create({ data: { ...base, ...resolved, ackStatus: EventAckStatus.ACCEPTED } });
    const record = await tx.attendanceRecord.create({
      data: {
        sessionId: decision.sessionId,
        memberId: decision.memberId,
        membershipId: decision.membershipId,
        cardAssignmentId: decision.cardAssignmentId,
        deviceId: ctx.deviceId,
        sourceEventId: event.id,
        source: AttendanceSource.DEVICE,
        capturedAt: tap.capturedAt,
        receivedAt: ctx.receivedAt,
        lateSync: decision.lateSync,
      },
    });
    await tx.attendanceEvent.update({ where: { id: event.id }, data: { attendanceRecordId: record.id } });
    return { clientEventId: tap.clientEventId, status: 'ACCEPTED', attendanceRecordId: record.id };
  }

  /**
   * Re-evaluate one stored REJECTED event against current data (after an admin fixed a membership
   * date, back-dated a card assignment, reinstated a session, …). The device's acknowledgement is
   * never changed; only the event's `resolution` and a new REPROCESSED record are written.
   */
  async reevaluate(
    tx: Tx,
    event: AttendanceEvent & { device: { assignedGroupId: string } },
  ): Promise<{ decision: AdmissionDecision; recordId?: string; alreadyRecordedId?: string }> {
    const facts = await this.loadFacts(tx, {
      cardUid: event.cardUid,
      capturedAt: event.capturedAt,
      receivedAt: event.receivedAt,
      claimedSessionId: event.claimedSessionId,
      deviceGroupId: event.device.assignedGroupId,
    });
    const decision = evaluateAdmission(facts, this.timing);
    if (decision.decision === 'REJECT') return { decision };

    const existing = await tx.attendanceRecord.findUnique({
      where: { sessionId_memberId: { sessionId: decision.sessionId, memberId: decision.memberId } },
      select: { id: true },
    });
    if (existing) return { decision, alreadyRecordedId: existing.id };
    const record = await tx.attendanceRecord.create({
      data: {
        sessionId: decision.sessionId,
        memberId: decision.memberId,
        membershipId: decision.membershipId,
        cardAssignmentId: decision.cardAssignmentId,
        deviceId: event.deviceId,
        sourceEventId: event.id,
        source: AttendanceSource.REPROCESSED,
        capturedAt: event.capturedAt,
        receivedAt: new Date(),
        lateSync: true,
      },
    });
    return { decision, recordId: record.id };
  }

  /** Gathers every fact the admission policy needs, as of the tap's capture time. */
  private async loadFacts(
    tx: Tx,
    p: { cardUid: string; capturedAt: Date; receivedAt: Date; claimedSessionId: string | null; deviceGroupId: string },
  ): Promise<AdmissionFacts> {
    const card = await tx.card.findUnique({ where: { cardUid: p.cardUid }, select: { id: true, status: true } });

    const assignment = card
      ? await tx.cardAssignment.findFirst({
          where: { cardId: card.id, assignedAt: { lte: p.capturedAt }, OR: [{ endedAt: null }, { endedAt: { gt: p.capturedAt } }] },
          select: { id: true, memberId: true },
        })
      : null;

    const endedBefore =
      card && !assignment
        ? (await tx.cardAssignment.count({ where: { cardId: card.id, status: CardAssignmentStatus.ENDED, endedAt: { lte: p.capturedAt } } })) > 0
        : false;

    const member = assignment
      ? await tx.member.findUnique({ where: { id: assignment.memberId }, select: { id: true, status: true, deactivatedAt: true } })
      : null;

    const memberships = member
      ? await tx.groupMembership.findMany({ where: { memberId: member.id }, select: { id: true, groupId: true, joinedAt: true, leftAt: true } })
      : [];

    const sessionSelect = { id: true, groupId: true, status: true, plannedStart: true, plannedEnd: true, openedAt: true, closedAt: true } as const;
    const claimed: SessionCandidate | null = isUuid(p.claimedSessionId)
      ? await tx.attendanceSession.findUnique({ where: { id: p.claimedSessionId }, select: sessionSelect })
      : null;
    // Candidate sessions whose admission window could contain the tap (graces are bounded to 12 h each).
    const candidates = await tx.attendanceSession.findMany({
      where: {
        groupId: p.deviceGroupId,
        plannedStart: { lte: new Date(p.capturedAt.getTime() + DAY_MS) },
        plannedEnd: { gte: new Date(p.capturedAt.getTime() - DAY_MS) },
      },
      select: sessionSelect,
    });

    return {
      capturedAt: p.capturedAt,
      receivedAt: p.receivedAt,
      minCaptureDate: new Date(`${this.config.CAPTURE_MIN_DATE}T00:00:00Z`),
      futureToleranceMs: this.config.CAPTURE_FUTURE_TOLERANCE_SECONDS * 1000,
      card,
      assignmentAtCapture: assignment,
      cardAssignmentEndedBeforeCapture: endedBefore,
      member,
      memberships,
      session: resolveSession(claimed, candidates, p.deviceGroupId, p.capturedAt, this.timing),
    };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string | null | undefined): v is string {
  return !!v && UUID.test(v);
}
