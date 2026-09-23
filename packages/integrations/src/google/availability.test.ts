import { describe, expect, it } from 'vitest';
import {
  computeSlots,
  dualZoneLabel,
  groupSlotsByLocalDate,
  isSlotAvailable,
  type ComputeSlotsInput,
} from './availability';

const lagosHours = {
  timeZone: 'Africa/Lagos',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
};
const torontoHours = { ...lagosHours, timeZone: 'America/Toronto' };

const base: ComputeSlotsInput = {
  workingHours: lagosHours,
  durationMinutes: 30,
  bufferMinutes: 15,
  minNoticeHours: 0,
  maxDaysAhead: 60,
  from: '2026-10-30T00:00:00Z',
  to: '2026-11-04T00:00:00Z',
  busy: [],
  now: '2026-10-29T12:00:00Z',
};

describe('computeSlots', () => {
  it('produces UTC slots from Lagos working hours and skips weekends', () => {
    const slots = computeSlots(base);
    const friday = slots.filter((s) => s.start.startsWith('2026-10-30'));
    expect(friday).toHaveLength(16);
    expect(friday[0]).toEqual({
      start: '2026-10-30T08:00:00.000Z',
      end: '2026-10-30T08:30:00.000Z',
    });
    expect(friday.at(-1)).toEqual({
      start: '2026-10-30T15:30:00.000Z',
      end: '2026-10-30T16:00:00.000Z',
    });
    expect(slots.some((s) => s.start.startsWith('2026-10-31'))).toBe(false); // Saturday
    expect(slots.some((s) => s.start.startsWith('2026-11-01'))).toBe(false); // Sunday
    expect(slots.filter((s) => s.start.startsWith('2026-11-02'))).toHaveLength(16);
  });

  it('excludes busy intervals expanded by the buffer', () => {
    const slots = computeSlots({
      ...base,
      busy: [{ start: '2026-10-30T10:00:00Z', end: '2026-10-30T10:30:00Z' }],
    });
    const friday = slots.filter((s) => s.start.startsWith('2026-10-30')).map((s) => s.start);
    expect(friday).toHaveLength(13);
    expect(friday).not.toContain('2026-10-30T09:30:00.000Z');
    expect(friday).not.toContain('2026-10-30T10:00:00.000Z');
    expect(friday).not.toContain('2026-10-30T10:30:00.000Z');
    expect(friday).toContain('2026-10-30T09:00:00.000Z');
    expect(friday).toContain('2026-10-30T11:00:00.000Z');
  });

  it('honours minimum notice, holidays and the booking horizon', () => {
    const notice = computeSlots({ ...base, now: '2026-11-02T07:30:00Z', minNoticeHours: 2 });
    expect(notice[0]?.start).toBe('2026-11-02T09:30:00.000Z');

    const holiday = computeSlots({ ...base, holidays: ['2026-11-02'] });
    expect(holiday.some((s) => s.start.startsWith('2026-11-02'))).toBe(false);
    expect(holiday.some((s) => s.start.startsWith('2026-11-03'))).toBe(true);

    const horizon = computeSlots({ ...base, maxDaysAhead: 3 });
    expect(horizon.some((s) => s.start.startsWith('2026-10-30'))).toBe(true);
    expect(horizon.some((s) => s.start.startsWith('2026-11-02'))).toBe(false);
  });

  it('keeps Lagos slots fixed in UTC across the Toronto DST end (2026-11-01)', () => {
    const slots = computeSlots(base);
    const before = slots.find((s) => s.start.startsWith('2026-10-30'))!;
    const after = slots.find((s) => s.start.startsWith('2026-11-02'))!;
    expect(before.start).toBe('2026-10-30T08:00:00.000Z');
    expect(after.start).toBe('2026-11-02T08:00:00.000Z');
    const labelBefore = dualZoneLabel(before.start, 'Africa/Lagos', 'America/Toronto', before.end);
    const labelAfter = dualZoneLabel(after.start, 'Africa/Lagos', 'America/Toronto', after.end);
    expect(labelBefore.business).toContain('09:00–09:30');
    expect(labelBefore.customer).toContain('04:00–04:30 EDT');
    expect(labelAfter.business).toContain('09:00–09:30');
    expect(labelAfter.customer).toContain('03:00–03:30 EST');
    expect(labelBefore.customerOffsetMinutes).toBe(-240);
    expect(labelAfter.customerOffsetMinutes).toBe(-300);
    expect(labelAfter.businessOffsetMinutes).toBe(60);
  });

  it('shows the Toronto DST start (2026-03-08) correctly for the same Lagos hour', () => {
    const slots = computeSlots({
      ...base,
      from: '2026-03-06T00:00:00Z',
      to: '2026-03-10T00:00:00Z',
      now: '2026-03-05T12:00:00Z',
    });
    const friday = slots.find((s) => s.start.startsWith('2026-03-06'))!;
    const monday = slots.find((s) => s.start.startsWith('2026-03-09'))!;
    expect(dualZoneLabel(friday.start, 'Africa/Lagos', 'America/Toronto').customer).toContain(
      '03:00 EST',
    );
    expect(dualZoneLabel(monday.start, 'Africa/Lagos', 'America/Toronto').customer).toContain(
      '04:00 EDT',
    );
  });

  it('shifts UTC instants when the business itself observes DST', () => {
    const autumn = computeSlots({ ...base, workingHours: torontoHours });
    expect(autumn.find((s) => s.start.startsWith('2026-10-30'))?.start).toBe(
      '2026-10-30T13:00:00.000Z',
    );
    expect(autumn.find((s) => s.start.startsWith('2026-11-02'))?.start).toBe(
      '2026-11-02T14:00:00.000Z',
    );
    const spring = computeSlots({
      ...base,
      workingHours: torontoHours,
      from: '2026-03-06T00:00:00Z',
      to: '2026-03-10T00:00:00Z',
      now: '2026-03-05T12:00:00Z',
    });
    expect(spring.find((s) => s.start.startsWith('2026-03-06'))?.start).toBe(
      '2026-03-06T14:00:00.000Z',
    );
    expect(spring.find((s) => s.start.startsWith('2026-03-09'))?.start).toBe(
      '2026-03-09T13:00:00.000Z',
    );
  });

  it('rechecks a proposed slot before confirmation', () => {
    const input = {
      ...base,
      busy: [{ start: '2026-10-30T10:00:00Z', end: '2026-10-30T10:30:00Z' }],
    };
    expect(
      isSlotAvailable({ start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:30:00Z' }, input),
    ).toBe(true);
    expect(
      isSlotAvailable({ start: '2026-10-30T10:00:00Z', end: '2026-10-30T10:30:00Z' }, input),
    ).toBe(false);
    expect(
      isSlotAvailable({ start: '2026-10-30T07:30:00Z', end: '2026-10-30T08:00:00Z' }, input),
    ).toBe(false);
  });

  it('labels dates that differ between zones and groups by local date', () => {
    const label = dualZoneLabel('2026-11-02T00:30:00Z', 'Africa/Lagos', 'America/Toronto');
    expect(label.dateDiffers).toBe(true);
    expect(label.business).toContain('Mon 2 Nov 2026, 01:30');
    expect(label.customer).toContain('Sun 1 Nov 2026, 19:30 EST');
    expect(label.sameZone).toBe(false);
    const grouped = groupSlotsByLocalDate(
      [{ start: '2026-11-02T00:30:00Z', end: '2026-11-02T01:00:00Z' }],
      'America/Toronto',
    );
    expect(Object.keys(grouped)).toEqual(['2026-11-01']);
  });

  it('validates inputs', () => {
    expect(() =>
      computeSlots({ ...base, workingHours: { ...lagosHours, timeZone: 'Mars/Olympus' } }),
    ).toThrow(/unknown time zone/);
    expect(() => computeSlots({ ...base, durationMinutes: 0 })).toThrow(/durationMinutes/);
    expect(() =>
      computeSlots({ ...base, workingHours: { ...lagosHours, start: '17:00', end: '09:00' } }),
    ).toThrow(/start before/);
    expect(computeSlots({ ...base, from: '2026-11-05T00:00:00Z' })).toEqual([]);
  });
});
