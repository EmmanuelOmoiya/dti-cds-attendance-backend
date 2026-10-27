import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { safeEqualHex, sha256 } from '../common/security/crypto';
import { AppConfig } from '../config/config.module';
import { Device, DeviceStatus, GroupStatus, SyncEventType, SyncResult } from '../generated/prisma/client';
import { normalizeDeviceIdentifier } from '../devices/devices.service';
import { DeviceActor } from '../auth/actor';

export interface DeviceTokenClaims {
  sub: string;
  typ: 'device';
  /** credentialVersion at issue time — rotation/revocation bump it, invalidating the token. */
  cv: number;
}

/** Verified on every protected sync request (DeviceAuthGuard). */
export type DeviceAuthFailure = 'UNKNOWN_DEVICE' | 'INVALID_CREDENTIAL' | 'DEVICE_NOT_ACTIVE' | 'GROUP_INACTIVE' | 'CREDENTIAL_SUPERSEDED' | 'INVALID_TOKEN';

@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Exchange `deviceIdentifier + secret` for a short-lived device token.
   * Unknown device and wrong secret produce the same 401 (no enumeration); both are audited.
   */
  async issueToken(identifierRaw: string, secret: string) {
    const started = Date.now();
    const deviceIdentifier = normalizeDeviceIdentifier(identifierRaw);
    const device = await this.prisma.device.findUnique({ where: { deviceIdentifier }, include: { group: true } });

    if (!device) {
      await this.fail(null, 'UNKNOWN_DEVICE', { deviceIdentifier });
      throw AppError.unauthenticated('Device authentication failed', ErrorCode.DEVICE_AUTH_FAILED);
    }
    if (!safeEqualHex(sha256(secret), device.secretHash)) {
      await this.fail(device, 'INVALID_CREDENTIAL');
      throw AppError.unauthenticated('Device authentication failed', ErrorCode.DEVICE_AUTH_FAILED);
    }
    if (device.status !== DeviceStatus.ACTIVE) {
      await this.fail(device, 'DEVICE_NOT_ACTIVE', { status: device.status });
      throw new AppError(HttpStatus.FORBIDDEN, ErrorCode.DEVICE_NOT_ACTIVE, `Device is ${device.status}`, { status: device.status });
    }
    if (device.group.status !== GroupStatus.ACTIVE) {
      await this.fail(device, 'GROUP_INACTIVE');
      throw new AppError(HttpStatus.FORBIDDEN, ErrorCode.DEVICE_GROUP_INACTIVE, "The device's group is inactive");
    }

    const accessToken = this.jwt.sign({ sub: device.id, typ: 'device', cv: device.credentialVersion } satisfies DeviceTokenClaims, {
      secret: this.config.DEVICE_JWT_SECRET,
      expiresIn: this.config.DEVICE_TOKEN_TTL_SECONDS,
      algorithm: 'HS256',
    });
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now } }),
      this.prisma.syncEvent.create({
        data: { deviceId: device.id, type: SyncEventType.TOKEN, result: SyncResult.SUCCESS, durationMs: Date.now() - started },
      }),
    ]);
    await this.audit.record(this.prisma, {
      actor: { type: 'DEVICE', id: device.id },
      action: 'device.authenticated',
      entityType: 'Device',
      entityId: device.id,
      groupId: device.assignedGroupId,
    });
    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: this.config.DEVICE_TOKEN_TTL_SECONDS,
      serverTime: now.toISOString(),
      device: { id: device.id, deviceIdentifier: device.deviceIdentifier, name: device.name, groupId: device.assignedGroupId },
    };
  }

  /**
   * Full authorization of a device request: valid token signature/type, device exists, is ACTIVE
   * (so not suspended, revoked or decommissioned), the token's credential version is current, and
   * the device's group is active. Returns the actor or throws (and audits the failure).
   */
  async authenticate(token: string | undefined): Promise<DeviceActor> {
    if (!token) throw AppError.unauthenticated('Device token required');
    let claims: DeviceTokenClaims;
    try {
      claims = this.jwt.verify<DeviceTokenClaims>(token, { secret: this.config.DEVICE_JWT_SECRET, algorithms: ['HS256'] });
      if (claims.typ !== 'device' || typeof claims.sub !== 'string' || typeof claims.cv !== 'number') throw new Error('wrong type');
    } catch {
      throw AppError.unauthenticated('Invalid or expired device token');
    }

    const device = await this.prisma.device.findUnique({ where: { id: claims.sub }, include: { group: { select: { status: true } } } });
    if (!device) {
      await this.fail(null, 'UNKNOWN_DEVICE', { deviceId: claims.sub });
      throw AppError.unauthenticated('Device authentication failed', ErrorCode.DEVICE_AUTH_FAILED);
    }
    if (device.status !== DeviceStatus.ACTIVE) {
      await this.fail(device, 'DEVICE_NOT_ACTIVE', { status: device.status });
      throw new AppError(HttpStatus.FORBIDDEN, ErrorCode.DEVICE_NOT_ACTIVE, `Device is ${device.status}`, { status: device.status });
    }
    if (claims.cv !== device.credentialVersion) {
      await this.fail(device, 'CREDENTIAL_SUPERSEDED');
      throw AppError.unauthenticated('Device credentials were rotated; obtain a new token', ErrorCode.DEVICE_AUTH_FAILED);
    }
    if (device.group.status !== GroupStatus.ACTIVE) {
      await this.fail(device, 'GROUP_INACTIVE');
      throw new AppError(HttpStatus.FORBIDDEN, ErrorCode.DEVICE_GROUP_INACTIVE, "The device's group is inactive");
    }
    return { type: 'DEVICE', id: device.id, deviceIdentifier: device.deviceIdentifier, groupId: device.assignedGroupId };
  }

  /** Security-relevant failure: audit log + (for known devices) a FAILED sync event. Never logs secrets. */
  private async fail(device: Device | null, reason: DeviceAuthFailure, extra: Record<string, unknown> = {}) {
    this.logger.warn({ deviceId: device?.id, reason, ...extra }, 'Device authentication rejected');
    try {
      await this.audit.record(this.prisma, {
        actor: device ? { type: 'DEVICE', id: device.id } : { type: 'ANONYMOUS' },
        action: 'device.auth_failed',
        entityType: 'Device',
        entityId: device?.id,
        groupId: device?.assignedGroupId,
        metadata: { reason, ...extra },
      });
      if (device) {
        await this.prisma.syncEvent.create({
          data: { deviceId: device.id, type: SyncEventType.TOKEN, result: SyncResult.FAILED, errorCode: reason },
        });
      }
    } catch (e) {
      this.logger.error({ err: String(e) }, 'Failed to record device auth failure');
    }
  }
}
