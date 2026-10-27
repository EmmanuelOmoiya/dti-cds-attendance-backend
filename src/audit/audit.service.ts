import { Injectable } from '@nestjs/common';
import { AccessScope } from '../auth/access-scope';
import { AuditActor } from '../auth/actor';
import { RequestContext } from '../common/context/request-context';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { AuditQueryDto } from './audit.dto';

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  groupId?: string | null;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|hash|authorization|cookie/i;

/** Defence in depth: strip anything that looks like a credential before it reaches the audit table. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Field-level diff for update audits: { field: { from, to } } for changed fields only. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[key];
    const a = from instanceof Date ? from.toISOString() : from;
    const b = to instanceof Date ? to.toISOString() : to;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[key] = { from: a, to: b };
  }
  return changes;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an audit row. Pass the transaction client so the audit row commits (or rolls back)
   * together with the change it describes.
   */
  async record(db: Tx | PrismaService, entry: AuditEntry): Promise<void> {
    const ctx = RequestContext.get();
    await db.auditLog.create({
      data: {
        actorType: entry.actor.type,
        actorId: entry.actor.id ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        groupId: entry.groupId ?? null,
        metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
      },
    });
  }

  async list(q: AuditQueryDto, scope: AccessScope) {
    const where: Prisma.AuditLogWhereInput = {
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      action: q.action ? { startsWith: q.action } : undefined,
      groupId: scope.narrow(q.groupId),
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: orderBy(q.sort, ['createdAt', 'action'], [{ createdAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return Page.of(
      rows.map((r) => ({ ...r, id: r.id.toString() })),
      total,
      q,
    );
  }
}
