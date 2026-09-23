import { describe, expect, it } from 'vitest';
import type { DurationObservation } from './approvals';
import {
  durationDays,
  permitElapsed,
  statutoryVsObserved,
  summarizeObservedDurations,
} from './approvals';

describe('durationDays', () => {
  it('counts elapsed days and echoes the basis', () => {
    expect(
      durationDays({ startedAt: '2026-09-01', endedAt: '2026-09-15', basis: 'elapsed' }),
    ).toEqual({
      ok: true,
      basis: 'elapsed',
      days: 14,
      startedAt: '2026-09-01',
      endedAt: '2026-09-15',
    });
  });

  it('counts business days, skipping the weekend and a holiday', () => {
    const plain = durationDays({
      startedAt: '2026-09-07',
      endedAt: '2026-09-14',
      basis: 'business',
      calendar: { weekend: [6, 7], holidays: [] },
    });
    expect(plain).toMatchObject({
      ok: true,
      basis: 'business',
      days: 5,
      calendarSource: 'provided',
    });

    const withHoliday = durationDays({
      startedAt: '2026-09-07',
      endedAt: '2026-09-14',
      basis: 'business',
      calendar: { weekend: [6, 7], holidays: ['2026-09-09'] },
    });
    expect(withHoliday).toMatchObject({ ok: true, days: 4 });
  });

  it('echoes the Saturday/Sunday convention when no calendar is supplied', () => {
    const result = durationDays({
      startedAt: '2026-09-07',
      endedAt: '2026-09-21',
      basis: 'business',
    });
    expect(result).toMatchObject({
      ok: true,
      days: 10,
      calendar: { weekend: [6, 7], holidays: [] },
      calendarSource: 'saturday_sunday_convention',
    });
  });

  it('rejects a missing basis and a reversed range', () => {
    expect(
      durationDays({
        startedAt: '2026-09-07',
        endedAt: '2026-09-14',
        basis: undefined as unknown as 'elapsed',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_basis' } });
    expect(
      durationDays({ startedAt: '2026-09-14', endedAt: '2026-09-07', basis: 'elapsed' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_range' },
    });
  });
});

describe('summarizeObservedDurations', () => {
  it('returns an empty summary, not a default, when there are no observations', () => {
    expect(summarizeObservedDurations([])).toEqual({
      groups: [],
      totalObservations: 0,
      ignored: 0,
    });
  });

  it('groups by jurisdiction, authority, permit type and basis with quartiles', () => {
    const lagos = (
      durationDays: number,
      dayBasis: 'elapsed' | 'business' = 'elapsed',
    ): DurationObservation => ({
      durationDays,
      dayBasis,
      permitType: 'building_permit',
      authority: 'LASPPPA',
      jurisdiction: 'Lagos',
    });
    const summary = summarizeObservedDurations([
      lagos(30),
      lagos(10),
      lagos(40),
      lagos(20),
      lagos(15, 'business'),
      {
        durationDays: 60,
        dayBasis: 'elapsed',
        permitType: 'building_permit',
        authority: 'ADP',
        jurisdiction: 'Abuja',
      },
    ]);
    expect(summary.totalObservations).toBe(6);
    expect(summary.groups).toHaveLength(3);
    expect(summary.groups[0]).toEqual({
      jurisdiction: 'Lagos',
      authority: 'LASPPPA',
      permitType: 'building_permit',
      dayBasis: 'elapsed',
      count: 4,
      min: 10,
      max: 40,
      median: 25,
      p25: 17.5,
      p75: 32.5,
    });
    expect(summary.groups[1]).toMatchObject({ dayBasis: 'business', count: 1, median: 15 });
    expect(summary.groups[2]).toMatchObject({ jurisdiction: 'Abuja', count: 1, median: 60 });
  });
});

describe('statutoryVsObserved', () => {
  const observed = {
    jurisdiction: 'Lagos',
    authority: 'LASPPPA',
    permitType: 'building_permit',
    dayBasis: 'elapsed' as const,
    count: 4,
    min: 10,
    max: 40,
    median: 25,
    p25: 17.5,
    p75: 32.5,
  };

  it('labels both figures separately and never blends them', () => {
    const result = statutoryVsObserved({
      statutoryTargetDays: 28,
      statutoryBasis: 'business',
      observed,
    });
    expect(result.statutory).toEqual({ label: 'statutory_target', days: 28, basis: 'business' });
    expect(result.observed).toEqual({
      label: 'observed',
      count: 4,
      median: 25,
      p25: 17.5,
      p75: 32.5,
      min: 10,
      max: 40,
      basis: 'elapsed',
    });
    expect(result.sameBasis).toBe(false);
    expect(Object.keys(result)).toEqual(['statutory', 'observed', 'sameBasis', 'note']);
  });

  it('keeps the statutory target when nothing has been observed', () => {
    const result = statutoryVsObserved({
      statutoryTargetDays: 28,
      statutoryBasis: 'business',
      observed: null,
    });
    expect(result.observed).toBeNull();
    expect(result.sameBasis).toBeNull();
    expect(result.statutory?.days).toBe(28);
  });
});

describe('permitElapsed', () => {
  const events = [
    { type: 'submitted' as const, occurredAt: '2026-09-01' },
    { type: 'query_raised' as const, occurredAt: '2026-09-11' },
    { type: 'resubmitted' as const, occurredAt: '2026-09-16' },
  ];

  it('splits open time between the applicant and the authority up to asOf', () => {
    const result = permitElapsed({ events, asOf: '2026-09-21' });
    expect(result).toMatchObject({
      basis: 'elapsed',
      applicantDays: 5,
      authorityDays: 15,
      totalDays: 20,
      status: 'with_authority',
    });
    expect(result.segments.map((s) => [s.court, s.days, s.closedBy])).toEqual([
      ['authority', 10, 'query_raised'],
      ['applicant', 5, 'resubmitted'],
      ['authority', 5, 'as_of'],
    ]);
  });

  it('stops the clock at the decision and ignores out-of-sequence events', () => {
    const result = permitElapsed({
      events: [
        ...events,
        { type: 'approved', occurredAt: '2026-09-20' },
        { type: 'query_raised', occurredAt: '2026-09-25' },
      ],
      asOf: '2026-10-01',
    });
    expect(result).toMatchObject({ applicantDays: 5, authorityDays: 14, status: 'decided' });
    expect(result.ignoredEvents).toEqual([
      { event: { type: 'query_raised', occurredAt: '2026-09-25' }, reason: 'after_decision' },
    ]);
  });

  it('reports nothing elapsed before submission', () => {
    const result = permitElapsed({ events: [], asOf: '2026-09-21' });
    expect(result).toMatchObject({
      applicantDays: 0,
      authorityDays: 0,
      status: 'not_submitted',
      segments: [],
    });
  });

  it('can count on the business basis with a calendar', () => {
    const result = permitElapsed({
      events: [{ type: 'submitted', occurredAt: '2026-09-07' }],
      asOf: '2026-09-14',
      basis: 'business',
      calendar: { weekend: [6, 7], holidays: ['2026-09-09'] },
    });
    expect(result).toMatchObject({ basis: 'business', authorityDays: 4, applicantDays: 0 });
  });
});
