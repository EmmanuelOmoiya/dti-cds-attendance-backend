import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessScope } from '../auth/access-scope';
import { auditActor, UserActor } from '../auth/actor';
import { AppError } from '../common/errors/app-error';
import { isUniqueViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { orderBy, Page, paging } from '../common/http/pagination';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { randomToken, sha256 } from '../common/security/crypto';
import { Device, DeviceStatus, GroupStatus, Prisma } from '../generated/prisma/client';
import { GroupsService } from '../groups/groups.service';
import { DeviceQueryDto, RegisterDeviceDto, SyncEventQueryDto, UpdateDeviceDto } from './devices.dto';

/** Allowed lifecycle transitions. REVOKED/DECOMMISSIONED devices can never sync again. */
const TRANSITIONS: Record<'activate' | 'suspend' | 'revoke' | 'decommission' | 'rotate', readonly DeviceStatus[]> = {
  activate: [DeviceStatus.PENDING, DeviceStatus.SUSPENDED],
  suspend: [DeviceStatus.PENDING, DeviceStatus.ACTIVE],
  revoke: [DeviceStatus.PENDING, DeviceStatus.ACTIVE, DeviceStatus.SUSPENDED],
  decommission: [DeviceStatus.PENDING, DeviceStatus.ACTIVE, DeviceStatus.SUSPENDED, DeviceStatus.REVOKED],
  rotate: [DeviceStatus.PENDING, DeviceStatus.ACTIVE, DeviceStatus.SUSPENDED],
};

export function newDeviceSecret(): { secret: string; secretHash: string } {
  const secret = randomToken(32, 'dsk_');
  return { secret, secretHash: sha256(secret) };
}

export const normalizeDeviceIdentifier = (raw: string) => raw.trim().toUpperCase();

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Never exposes secretHash. */
  view(d: Device & { group?: { id: string; name: string } }) {
    const { secretHash: _omit, ...rest } = d;
    return rest;
  }

  /**
   * Register a device. The credential secret is returned ONCE in this response; only its hash is
   * stored. The device starts PENDING and cannot sync until an administrator activates it.
   */
  async register(dto: RegisterDeviceDto, actor: UserActor) {
    const deviceIdentifier = normalizeDeviceIdentifier(dto.deviceIdentifier);
    const { secret, secretHash } = newDeviceSecret();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await GroupsService.requireActive(tx, dto.assignedGroupId, actor.scope);
        const device = await tx.device.create({
          data: { deviceIdentifier, name: dto.name.trim(), assignedGroupId: dto.assignedGroupId, secretHash, createdById: actor.id },
        });
        await this.audit.record(tx, {
          actor: auditActor(actor),
          action: 'device.registered',
          entityType: 'Device',
          entityId: device.id,
          groupId: device.assignedGroupId,
          metadata: { deviceIdentifier, name: device.name },
        });
        return {
          device: this.view(device),
          credentials: { deviceIdentifier, secret, notice: 'Store this secret on the device now. It cannot be retrieved again; rotate credentials if it is lost.' },
        };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'deviceIdentifier')) throw AppError.conflict(ErrorCode.DEVICE_IDENTIFIER_TAKEN, 'A device with this identifier already exists');
      throw e;
    }
  }

  async list(q: DeviceQueryDto, scope: AccessScope) {
    const where: Prisma.DeviceWhereInput = {
      assignedGroupId: scope.narrow(q.groupId),
      status: q.status,
      OR: q.q ? [{ deviceIdentifier: { contains: q.q.toUpperCase() } }, { name: { contains: q.q, mode: 'insensitive' } }] : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.device.findMany({
        where,
        include: { group: { select: { id: true, name: true } } },
        orderBy: orderBy(q.sort, ['deviceIdentifier', 'name', 'lastSeenAt', 'createdAt', 'status'], [{ createdAt: 'desc' }]),
        ...paging(q),
      }),
      this.prisma.device.count({ where }),
    ]);
    return Page.of(rows.map((d) => this.view(d)), total, q);
  }

  async get(id: string, scope: AccessScope) {
    const d = await this.load(this.prisma, id, scope);
    const lastSync = await this.prisma.syncEvent.findFirst({ where: { deviceId: id, type: 'UPLOAD' }, orderBy: { createdAt: 'desc' } });
    const pendingFromHeartbeat = (d.lastStatus as Record<string, unknown> | null)?.pendingEvents ?? null;
    return { ...this.view(d), lastUpload: lastSync, reportedPendingEvents: pendingFromHeartbeat };
  }

  async update(id: string, dto: UpdateDeviceDto, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const d = await this.load(tx, id, actor.scope);
      if (dto.assignedGroupId && dto.assignedGroupId !== d.assignedGroupId) {
        await GroupsService.requireActive(tx, dto.assignedGroupId, actor.scope);
      }
      const updated = await tx.device.update({ where: { id }, data: { name: dto.name?.trim(), assignedGroupId: dto.assignedGroupId } });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'device.updated',
        entityType: 'Device',
        entityId: id,
        groupId: d.assignedGroupId,
        metadata: {
          name: dto.name !== undefined ? { from: d.name, to: updated.name } : undefined,
          assignedGroupId: dto.assignedGroupId !== undefined ? { from: d.assignedGroupId, to: updated.assignedGroupId } : undefined,
        },
      });
      return this.view(updated);
    });
  }

  activate(id: string, reason: string | undefined, actor: UserActor) {
    return this.changeStatus(id, 'activate', DeviceStatus.ACTIVE, reason, actor, async (tx, d) => {
      const group = await tx.cdsGroup.findUniqueOrThrow({ where: { id: d.assignedGroupId } });
      if (group.status !== GroupStatus.ACTIVE) throw AppError.rule(ErrorCode.GROUP_INACTIVE, "The device's group is inactive");
      return { activatedAt: new Date(), suspendedAt: null };
    });
  }

  suspend(id: string, reason: string | undefined, actor: UserActor) {
    return this.changeStatus(id, 'suspend', DeviceStatus.SUSPENDED, reason, actor, async () => ({ suspendedAt: new Date() }));
  }

  /** Stolen/compromised: immediate and permanent. Outstanding tokens stop working on the next request. */
  revoke(id: string, reason: string | undefined, actor: UserActor) {
    return this.changeStatus(id, 'revoke', DeviceStatus.REVOKED, reason, actor, async (_tx, d) => ({
      revokedAt: new Date(),
      credentialVersion: d.credentialVersion + 1,
    }));
  }

  decommission(id: string, reason: string | undefined, actor: UserActor) {
    return this.changeStatus(id, 'decommission', DeviceStatus.DECOMMISSIONED, reason, actor, async (_tx, d) => ({
      decommissionedAt: new Date(),
      credentialVersion: d.credentialVersion + 1,
    }));
  }

  /** Issue a new secret; the old secret and every token issued with it stop working immediately. */
  async rotateCredentials(id: string, actor: UserActor) {
    return this.prisma.$transaction(async (tx) => {
      const d = await this.load(tx, id, actor.scope);
      if (!TRANSITIONS.rotate.includes(d.status)) throw AppError.transition('device', d.status, 'rotate credentials of');
      const { secret, secretHash } = newDeviceSecret();
      const updated = await tx.device.update({
        where: { id },
        data: { secretHash, credentialVersion: d.credentialVersion + 1, credentialRotatedAt: new Date() },
      });
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: 'device.credentials_rotated',
        entityType: 'Device',
        entityId: id,
        groupId: d.assignedGroupId,
        metadata: { credentialVersion: updated.credentialVersion },
      });
      return {
        device: this.view(updated),
        credentials: { deviceIdentifier: d.deviceIdentifier, secret, notice: 'Load this secret onto the device. The previous secret no longer works.' },
      };
    });
  }

  async syncEvents(id: string, q: SyncEventQueryDto, scope: AccessScope) {
    await this.load(this.prisma, id, scope);
    const where: Prisma.SyncEventWhereInput = { deviceId: id, type: q.type };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.syncEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...paging(q) }),
      this.prisma.syncEvent.count({ where }),
    ]);
    return Page.of(rows, total, q);
  }

  private async changeStatus(
    id: string,
    action: keyof typeof TRANSITIONS,
    to: DeviceStatus,
    reason: string | undefined,
    actor: UserActor,
    extra: (tx: Tx, d: Device) => Promise<Prisma.DeviceUpdateManyMutationInput>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const d = await this.load(tx, id, actor.scope);
      if (!TRANSITIONS[action].includes(d.status)) throw AppError.transition('device', d.status, action);
      const data = await extra(tx, d);
      const { count } = await tx.device.updateMany({ where: { id, status: d.status }, data: { ...data, status: to, statusReason: reason ?? null } });
      if (count !== 1) throw AppError.conflict(ErrorCode.CONFLICT, 'The device was modified concurrently; retry');
      await this.audit.record(tx, {
        actor: auditActor(actor),
        action: `device.${action === 'activate' ? 'activated' : action === 'suspend' ? 'suspended' : action === 'revoke' ? 'revoked' : 'decommissioned'}`,
        entityType: 'Device',
        entityId: id,
        groupId: d.assignedGroupId,
        metadata: { from: d.status, to, reason },
      });
      return this.view(await tx.device.findUniqueOrThrow({ where: { id } }));
    });
  }

  private async load(db: Tx | PrismaService, id: string, scope: AccessScope) {
    const d = await db.device.findUnique({ where: { id }, include: { group: { select: { id: true, name: true } } } });
    if (!d || !scope.canAccess(d.assignedGroupId)) throw AppError.notFound('Device');
    return d;
  }
}
