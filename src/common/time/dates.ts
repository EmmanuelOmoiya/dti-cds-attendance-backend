import { DateTime, IANAZone } from 'luxon';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

/**
 * Prisma maps PostgreSQL `date` columns to JS Dates at 00:00 UTC. These helpers convert between
 * that representation and `YYYY-MM-DD` strings without any timezone shifting.
 */
export function toDateOnly(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function fromDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The local calendar date of an instant in a timezone. */
export function localDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: 'UTC' }).plus({ days }).toISODate()!;
}

export function assertTimezone(zone: string): void {
  if (!IANAZone.isValidZone(zone)) {
    throw AppError.validation(`'${zone}' is not a valid IANA timezone`, [{ field: 'timezone', issues: [ErrorCode.INVALID_TIMEZONE] }]);
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
