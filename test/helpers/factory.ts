import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { localDate, toDateOnly } from '../../src/common/time/dates';
import { newDeviceSecret } from '../../src/devices/devices.service';
import { DeviceStatus, SessionStatus } from '../../src/generated/prisma/client';

let seq = 0;
const next = () => ++seq;

/** Direct-to-database fixtures for integration tests (bypass HTTP for speed). */
export class Factory {
  constructor(private readonly prisma: PrismaService) {}

  group(name = `Group ${next()}`) {
    return this.prisma.cdsGroup.create({ data: { name, nameNormalized: name.toLowerCase() } });
  }

  async member(groupId: string, joinedAt: Date, opts: { leftAt?: Date; name?: string } = {}) {
    const n = next();
    const member = await this.prisma.member.create({ data: { fullName: opts.name ?? `Member ${n}`, stateCode: `LA/25A/${String(n).padStart(5, '0')}` } });
    const membership = await this.prisma.groupMembership.create({
      data: { memberId: member.id, groupId, joinedAt, leftAt: opts.leftAt ?? null, endReason: opts.leftAt ? 'OTHER' : null },
    });
    return { member, membership };
  }

  async card(memberId?: string, assignedAt?: Date, uid?: string) {
    const cardUid = uid ?? `04${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const card = await this.prisma.card.create({ data: { cardUid, status: memberId ? 'ASSIGNED' : 'UNASSIGNED' } });
    const assignment = memberId
      ? await this.prisma.cardAssignment.create({ data: { cardId: card.id, memberId, assignedAt: assignedAt ?? new Date(Date.now() - 365 * 86_400_000) } })
      : null;
    return { card, assignment };
  }

  /** A session in any state; CLOSED/OPEN get the held-confirmation fields the DB requires. */
  session(groupId: string, plannedStart: Date, plannedEnd: Date, status: SessionStatus = SessionStatus.SCHEDULED, extra: { closedAt?: Date; openedAt?: Date } = {}) {
    const held = status === SessionStatus.OPEN || status === SessionStatus.CLOSED;
    return this.prisma.attendanceSession.create({
      data: {
        groupId,
        origin: 'AD_HOC',
        title: `Session ${next()}`,
        timezone: 'Africa/Lagos',
        occurrenceDate: toDateOnly(localDate(plannedStart, 'Africa/Lagos')),
        plannedStart,
        plannedEnd,
        status,
        openedAt: held ? (extra.openedAt ?? plannedStart) : null,
        closedAt: status === SessionStatus.CLOSED ? (extra.closedAt ?? new Date(plannedEnd.getTime() + 30 * 60_000)) : null,
        heldConfirmation: held ? 'CONFIRMED_RETROSPECTIVELY' : null,
        heldConfirmedAt: held ? new Date() : null,
        cancellationReason: status === SessionStatus.CANCELLED ? 'NOT_HELD' : null,
        cancelledAt: status === SessionStatus.CANCELLED ? new Date() : null,
      },
    });
  }

  async device(groupId: string, status: DeviceStatus = DeviceStatus.ACTIVE) {
    const { secret, secretHash } = newDeviceSecret();
    const device = await this.prisma.device.create({
      data: { deviceIdentifier: `DEV-${next()}-${randomUUID().slice(0, 6)}`.toUpperCase(), name: 'Test reader', assignedGroupId: groupId, status, secretHash },
    });
    return { device, secret };
  }
}
