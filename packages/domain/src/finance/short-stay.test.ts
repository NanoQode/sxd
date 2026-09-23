import { describe, expect, it } from 'vitest';
import type { Result } from './result';
import type { ShortStayInput } from './short-stay';
import { shortStayEconomics } from './short-stay';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

/** Hypothetical figures: 300 nights offered, 60% occupied, NGN 50,000/night. */
const base: ShortStayInput = {
  availableNightsPerYear: 300,
  occupiedNightFraction: 0.6,
  nightlyRate: 50_000,
  platformChargeFraction: 0.15,
  cleaningCostPerStay: 15_000,
  stays: { averageLengthOfStayNights: 3 },
  annualOperatingCosts: 1_500_000,
  denominator: { kind: 'acquisition_basis', amount: 60_000_000 },
};

describe('shortStayEconomics', () => {
  it('builds revenue from available nights, occupancy and nightly rate, then nets charges and costs', () => {
    const economics = unwrap(shortStayEconomics(base));
    expect(economics.kind).toBe('short_stay');
    expect(economics.occupiedNights).toBe(180);
    expect(economics.grossBookingRevenue).toBe(9_000_000);
    expect(economics.platformCharges).toBe(1_350_000);
    expect(economics.netBookingRevenue).toBe(7_650_000);
    expect(economics.numberOfStays).toBe(60);
    expect(economics.stayCountBasis).toBe('average_length_of_stay');
    expect(economics.cleaningCosts).toBe(900_000);
    expect(economics.netOperatingIncome).toBe(5_250_000);
    expect(unwrap(economics.grossYieldPercent)).toBeCloseTo(15, 10);
    expect(unwrap(economics.netYieldPercent)).toBeCloseTo(8.75, 10);
    expect(economics.denominator?.kind).toBe('acquisition_basis');
  });

  it('accepts an explicit number of stays instead of an average length of stay', () => {
    const economics = unwrap(shortStayEconomics({ ...base, stays: { numberOfStays: 50 } }));
    expect(economics.stayCountBasis).toBe('number_of_stays');
    expect(economics.numberOfStays).toBe(50);
    expect(economics.averageLengthOfStayNights).toBeCloseTo(3.6, 10);
    expect(economics.cleaningCosts).toBe(750_000);
  });

  it('never assumes 365 nights: available nights are an explicit input', () => {
    const missing = failure(
      shortStayEconomics({
        ...base,
        availableNightsPerYear: undefined,
      } as unknown as ShortStayInput),
    );
    expect(missing.missing).toEqual(['availableNightsPerYear']);

    const hundredNights = unwrap(
      shortStayEconomics({ ...base, availableNightsPerYear: 100, occupiedNightFraction: 1 }),
    );
    expect(hundredNights.grossBookingRevenue).toBe(100 * 50_000);
    expect(hundredNights.grossBookingRevenue).not.toBe(365 * 50_000);

    expect(failure(shortStayEconomics({ ...base, availableNightsPerYear: 400 })).reason).toMatch(
      /cannot exceed 366/,
    );
  });

  it('rejects stays given both ways and requires one of them', () => {
    const both = failure(
      shortStayEconomics({
        ...base,
        stays: {
          averageLengthOfStayNights: 3,
          numberOfStays: 50,
        } as unknown as ShortStayInput['stays'],
      }),
    );
    expect(both.reason).toMatch(/supply exactly one/);
    const neither = failure(
      shortStayEconomics({ ...base, stays: {} as unknown as ShortStayInput['stays'] }),
    );
    expect(neither.missing).toEqual(['stays.averageLengthOfStayNights or stays.numberOfStays']);
  });

  it('reports yields as unavailable without a cost denominator', () => {
    const { denominator: _omitted, ...withoutDenominator } = base;
    const economics = unwrap(shortStayEconomics(withoutDenominator));
    expect(economics.denominator).toBeNull();
    expect(economics.netOperatingIncome).toBe(5_250_000);
    expect(failure(economics.netYieldPercent).missing).toEqual(['denominator']);
    expect(failure(economics.grossYieldPercent).reason).toMatch(/No yield/);
  });

  it('rejects rates outside 0–1', () => {
    expect(failure(shortStayEconomics({ ...base, occupiedNightFraction: 1.2 })).reason).toMatch(
      /occupiedNightFraction must be a fraction/,
    );
    expect(failure(shortStayEconomics({ ...base, platformChargeFraction: -0.1 })).reason).toMatch(
      /platformChargeFraction must be a fraction/,
    );
  });
});
