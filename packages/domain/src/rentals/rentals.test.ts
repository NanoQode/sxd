import { describe, expect, it } from 'vitest';
import {
  addMonths,
  ageArrears,
  computeStatementTotals,
  daysInclusive,
  generateRentSchedule,
  isSlaBreached,
  leaseManagementFee,
  monthsInPeriod,
  nextServiceDate,
  nightsBetween,
  periodsDueForInvoicing,
  prorateByDays,
  slaDueAt,
  staysOverlap,
  warrantyStatus,
} from './index';

describe('calendar helpers', () => {
  it('adds months with end-of-month clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-15', 12)).toBe('2027-03-15');
  });
  it('counts inclusive days', () => {
    expect(daysInclusive('2026-01-01', '2026-01-31')).toBe(31);
    expect(daysInclusive('2026-02-01', '2026-02-28')).toBe(28);
    expect(() => daysInclusive('2026-02-02', '2026-02-01')).toThrow();
  });
});

describe('generateRentSchedule', () => {
  it('produces whole monthly periods for an exact-year lease', () => {
    const periods = generateRentSchedule({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      rentAmountKobo: 50_000_000n,
      rentPeriod: 'monthly',
    });
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      dueDate: '2026-01-01',
      amountKobo: 50_000_000n,
      proration: null,
    });
    expect(periods[11]).toMatchObject({ periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    expect(periods.every((p) => p.proration === null)).toBe(true);
  });

  it('prorates a truncated last period by days over the full period, half-up', () => {
    const periods = generateRentSchedule({
      startDate: '2026-01-15',
      endDate: '2026-03-31',
      rentAmountKobo: 31_000_000n,
      rentPeriod: 'monthly',
    });
    expect(periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ['2026-01-15', '2026-02-14'],
      ['2026-02-15', '2026-03-14'],
      ['2026-03-15', '2026-03-31'],
    ]);
    // 17 days of a 31-day period (15 Mar – 14 Apr): 31,000,000 × 17 / 31 = 17,000,000.
    expect(periods[2]!.amountKobo).toBe(17_000_000n);
    expect(periods[2]!.proration).toEqual({ days: 17, ofDays: 31 });
  });

  it('can charge the agreed rent for a truncated period when the lease says so', () => {
    const periods = generateRentSchedule({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      rentAmountKobo: 120_000_000n,
      rentPeriod: 'annual',
      prorate: false,
    });
    expect(periods).toHaveLength(1);
    expect(periods[0]!.amountKobo).toBe(120_000_000n);
    expect(periods[0]!.proration).toBeNull();
  });

  it('prorates an annual lease ending mid-year', () => {
    const periods = generateRentSchedule({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      rentAmountKobo: 365_000_00n,
      rentPeriod: 'annual',
    });
    expect(periods).toHaveLength(1);
    expect(periods[0]!.proration).toEqual({ days: 181, ofDays: 365 });
    expect(periods[0]!.amountKobo).toBe(prorateByDays(365_000_00n, 181, 365));
    expect(periods[0]!.amountKobo).toBe(18_100_000n);
  });

  it('applies the due-date lead and generates a horizon for open-ended leases', () => {
    const periods = generateRentSchedule({
      startDate: '2026-04-01',
      endDate: null,
      rentAmountKobo: 1_000n,
      rentPeriod: 'quarterly',
      dueLeadDays: 7,
      horizonPeriods: 3,
    });
    expect(periods).toHaveLength(3);
    expect(periods[0]!.dueDate).toBe('2026-03-25');
    expect(periods[2]!.periodStart).toBe('2026-10-01');
  });

  it('takes academic terms verbatim and refuses overlaps', () => {
    const periods = generateRentSchedule({
      startDate: '2026-09-01',
      endDate: '2027-06-30',
      rentAmountKobo: 40_000_000n,
      rentPeriod: 'term',
      academicTerms: [
        { label: 'Second semester', start: '2027-02-01', end: '2027-06-30' },
        { label: 'First semester', start: '2026-09-01', end: '2027-01-15', amountKobo: 45_000_000n },
      ],
    });
    expect(periods.map((p) => p.label)).toEqual(['First semester', 'Second semester']);
    expect(periods[0]!.amountKobo).toBe(45_000_000n);
    expect(periods[1]!.amountKobo).toBe(40_000_000n);
    expect(() =>
      generateRentSchedule({
        startDate: '2026-09-01',
        endDate: '2027-06-30',
        rentAmountKobo: 1n,
        rentPeriod: 'term',
        academicTerms: [
          { label: 'a', start: '2026-09-01', end: '2027-01-15' },
          { label: 'b', start: '2027-01-10', end: '2027-06-30' },
        ],
      }),
    ).toThrow(/overlap/);
    expect(() =>
      generateRentSchedule({ startDate: '2026-09-01', endDate: null, rentAmountKobo: 1n, rentPeriod: 'term' }),
    ).toThrow(/at least one term/);
  });

  it('rejects invalid input', () => {
    expect(() =>
      generateRentSchedule({ startDate: '2026-02-30', endDate: null, rentAmountKobo: 1n, rentPeriod: 'monthly' }),
    ).toThrow();
    expect(() =>
      generateRentSchedule({ startDate: '2026-02-01', endDate: '2026-01-01', rentAmountKobo: 1n, rentPeriod: 'monthly' }),
    ).toThrow(/before/);
    expect(() => prorateByDays(100n, 0, 30)).toThrow();
  });

  it('selects periods due within the lead window', () => {
    const periods = [
      { dueDate: '2026-09-20', status: 'scheduled' },
      { dueDate: '2026-09-25', status: 'scheduled' },
      { dueDate: '2026-09-20', status: 'invoiced' },
      { dueDate: '2026-10-20', status: 'scheduled' },
    ];
    expect(periodsDueForInvoicing(periods, '2026-09-22', 5).map((p) => p.dueDate)).toEqual([
      '2026-09-20',
      '2026-09-25',
    ]);
  });
});

describe('ageArrears', () => {
  it('buckets outstanding charges by days overdue', () => {
    const charges = [
      { id: 'a', amountKobo: 1_000n, chargedAt: '2026-01-01', dueDate: '2026-01-01' },
      { id: 'b', amountKobo: 2_000n, chargedAt: '2026-08-01', dueDate: '2026-08-01' },
      { id: 'c', amountKobo: 3_000n, chargedAt: '2026-09-10', dueDate: '2026-09-10' },
      { id: 'd', amountKobo: 4_000n, chargedAt: '2026-10-01', dueDate: '2026-10-01' },
    ];
    const allocations = [{ rentChargeId: 'b', amountKobo: 500n }];
    const ageing = ageArrears(charges, allocations, '2026-09-22');
    expect(ageing.buckets).toEqual({
      current: 4_000n,
      days_1_30: 3_000n,
      days_31_60: 1_500n,
      days_61_90: 0n,
      days_over_90: 1_000n,
    });
    expect(ageing.totalOutstandingKobo).toBe(9_500n);
    expect(ageing.items[0]).toMatchObject({ chargeId: 'a', bucket: 'days_over_90' });
    expect(ageing.items.find((i) => i.chargeId === 'd')?.daysOverdue).toBe(0);
  });
});

describe('owner statement maths', () => {
  it('nets fees and recoveries against collections and keeps arrears separate', () => {
    const totals = computeStatementTotals([
      { kind: 'rent_collected', description: 'Rent', amountKobo: 2_400_000n },
      { kind: 'service_charge_collected', description: 'Service', amountKobo: 100_000n },
      { kind: 'management_fee', description: 'Fee', amountKobo: 240_000n },
      { kind: 'maintenance_recovery', description: 'Plumber', amountKobo: 50_000n },
      { kind: 'arrears', description: 'Owed', amountKobo: 900_000n },
      { kind: 'short_stay_income', description: 'Stay', amountKobo: 999n },
    ]);
    expect(totals).toEqual({
      collectedKobo: 2_500_000n,
      feesKobo: 240_000n,
      expensesKobo: 50_000n,
      netKobo: 2_210_000n,
      arrearsKobo: 900_000n,
    });
  });
  it('computes management fees per basis', () => {
    expect(leaseManagementFee({ basis: 'percentage_of_collected', feeBps: 1000 }, 2_400_000n, 1)).toBe(240_000n);
    expect(leaseManagementFee({ basis: 'percentage_of_collected', feeBps: 1000 }, 0n, 1)).toBe(0n);
    expect(leaseManagementFee({ basis: 'fixed_monthly', fixedKobo: 5_000n }, 0n, 3)).toBe(15_000n);
    expect(leaseManagementFee({ basis: 'none' }, 1_000n, 1)).toBe(0n);
    expect(monthsInPeriod('2026-01-01', '2026-03-31')).toBe(3);
    expect(monthsInPeriod('2026-01-10', '2026-01-20')).toBe(1);
  });
});

describe('SLA, assets and stays', () => {
  it('computes SLA deadlines and breach flags', () => {
    const created = new Date('2026-09-22T08:00:00Z');
    expect(slaDueAt('urgent', created).toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect(slaDueAt('low', created).toISOString()).toBe('2026-09-29T08:00:00.000Z');
    const due = slaDueAt('normal', created);
    expect(isSlaBreached('in_progress', due, new Date('2026-09-26T00:00:00Z'))).toBe(true);
    expect(isSlaBreached('in_progress', due, new Date('2026-09-23T00:00:00Z'))).toBe(false);
    expect(isSlaBreached('completed', due, new Date('2026-09-26T00:00:00Z'))).toBe(false);
    expect(isSlaBreached('requested', null, new Date())).toBe(false);
  });
  it('schedules asset service and grades warranties', () => {
    expect(nextServiceDate('2026-09-22', 90)).toBe('2026-12-21');
    expect(nextServiceDate('2026-09-22', null)).toBeNull();
    expect(warrantyStatus('2026-10-01', '2026-09-22')).toBe('expiring');
    expect(warrantyStatus('2027-10-01', '2026-09-22')).toBe('active');
    expect(warrantyStatus('2026-09-01', '2026-09-22')).toBe('expired');
  });
  it('detects overlapping stays and allows same-day turnover', () => {
    expect(nightsBetween('2026-09-22', '2026-09-25')).toBe(3);
    expect(() => nightsBetween('2026-09-22', '2026-09-22')).toThrow();
    const a = { checkIn: '2026-09-22', checkOut: '2026-09-25' };
    expect(staysOverlap(a, { checkIn: '2026-09-25', checkOut: '2026-09-27' })).toBe(false);
    expect(staysOverlap(a, { checkIn: '2026-09-24', checkOut: '2026-09-27' })).toBe(true);
    expect(staysOverlap(a, { checkIn: '2026-09-20', checkOut: '2026-09-23' })).toBe(true);
  });
});
