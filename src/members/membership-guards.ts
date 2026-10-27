import { AppError } from '../common/errors/app-error';
import { isExclusionViolation } from '../common/errors/db-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { Tx } from '../common/prisma/prisma.service';
import { AttendanceRecordStatus } from '../generated/prisma/client';

/**
 * A membership period may not be changed so that existing PRESENT attendance falls outside it —
 * otherwise "present ⊆ eligible" would silently break and percentages could exceed 100%.
 * Admins must void those records explicitly first.
 */
export async function assertNoAttendanceOutside(tx: Tx, membershipId: string, joinedAt: Date, leftAt: Date | null): Promise<void> {
  const outside = await tx.attendanceRecord.findMany({
    where: {
      membershipId,
      status: AttendanceRecordStatus.PRESENT,
      session: { OR: [{ plannedStart: { lt: joinedAt } }, ...(leftAt ? [{ plannedStart: { gte: leftAt } }] : [])] },
    },
    select: { id: true, sessionId: true },
    take: 50,
  });
  if (outside.length) {
    throw AppError.conflict(
      ErrorCode.MEMBERSHIP_HAS_ATTENDANCE,
      'This change would leave attendance records outside the membership period; void them first',
      { records: outside },
    );
  }
}

export function mapMembershipOverlap(e: unknown): never {
  if (isExclusionViolation(e, 'GroupMembership_no_overlap')) {
    throw AppError.conflict(ErrorCode.MEMBERSHIP_OVERLAP, 'The member already belongs to a CDS group during that period');
  }
  throw e;
}
