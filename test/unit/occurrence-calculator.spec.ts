import { occurrencesBetween, ScheduleRule } from '../../src/schedules/occurrence-calculator';

const friday: ScheduleRule = {
  dayOfWeek: 5,
  startLocalTime: '10:00',
  endLocalTime: '13:00',
  timezone: 'Africa/Lagos',
  effectiveFrom: '2026-11-01',
  effectiveUntil: null,
};

describe('schedule occurrence calculator', () => {
  it('produces every Friday in range with local times converted to UTC (Lagos = UTC+1)', () => {
    const occ = occurrencesBetween(friday, '2026-11-01', '2026-11-30');
    expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27']);
    expect(occ[0].plannedStart.toISOString()).toBe('2026-11-06T09:00:00.000Z');
    expect(occ[0].plannedEnd.toISOString()).toBe('2026-11-06T12:00:00.000Z');
  });

  it('is clipped to the effective period (inclusive)', () => {
    const occ = occurrencesBetween({ ...friday, effectiveFrom: '2026-11-13', effectiveUntil: '2026-11-20' }, '2026-11-01', '2026-12-31');
    expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-11-13', '2026-11-20']);
  });

  it('returns nothing when the range is outside the effective period', () => {
    expect(occurrencesBetween({ ...friday, effectiveUntil: '2026-10-01', effectiveFrom: '2026-09-01' }, '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('handles Monday schedules starting mid-week', () => {
    const occ = occurrencesBetween({ ...friday, dayOfWeek: 1 }, '2026-11-04', '2026-11-20');
    expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-11-09', '2026-11-16']);
  });

  it('keeps local wall-clock time across a DST change in zones that have one', () => {
    const london: ScheduleRule = { ...friday, timezone: 'Europe/London', effectiveFrom: '2026-10-01' };
    const occ = occurrencesBetween(london, '2026-10-16', '2026-10-31');
    // BST (UTC+1) on 16 and 23 Oct; GMT from 25 Oct.
    expect(occ.map((o) => o.plannedStart.toISOString())).toEqual(['2026-10-16T09:00:00.000Z', '2026-10-23T09:00:00.000Z', '2026-10-30T10:00:00.000Z']);
  });
});
