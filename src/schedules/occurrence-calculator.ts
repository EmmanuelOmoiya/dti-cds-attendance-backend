import { DateTime } from 'luxon';

export interface ScheduleRule {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  /** "HH:mm" local time in `timezone`. */
  startLocalTime: string;
  endLocalTime: string;
  timezone: string;
  /** Inclusive local dates (YYYY-MM-DD). */
  effectiveFrom: string;
  effectiveUntil: string | null;
}

export interface Occurrence {
  occurrenceDate: string;
  plannedStart: Date;
  plannedEnd: Date;
}

/**
 * Expected meeting occurrences of a weekly schedule within [fromDate, toDate] (inclusive local
 * dates), clipped to the schedule's effective period. Local wall-clock times are converted to
 * UTC instants in the schedule's IANA timezone (DST-safe via Luxon).
 */
export function occurrencesBetween(rule: ScheduleRule, fromDate: string, toDate: string): Occurrence[] {
  const zone = rule.timezone;
  const start = maxDate(fromDate, rule.effectiveFrom);
  const end = rule.effectiveUntil ? minDate(toDate, rule.effectiveUntil) : toDate;
  if (start > end) return [];

  let day = DateTime.fromISO(start, { zone });
  const offset = (rule.dayOfWeek - day.weekday + 7) % 7;
  day = day.plus({ days: offset });

  const result: Occurrence[] = [];
  const last = DateTime.fromISO(end, { zone });
  while (day <= last) {
    const date = day.toISODate()!;
    result.push({
      occurrenceDate: date,
      plannedStart: atLocal(date, rule.startLocalTime, zone),
      plannedEnd: atLocal(date, rule.endLocalTime, zone),
    });
    day = day.plus({ weeks: 1 });
  }
  return result;
}

function atLocal(date: string, time: string, zone: string): Date {
  return DateTime.fromISO(`${date}T${time}`, { zone }).toUTC().toJSDate();
}

const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);
