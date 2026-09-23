import { describe, expect, it } from 'vitest';
import type { BuildCostInput, BuildInclusions, DevelopmentCostInput } from './development-cost';
import { areaRateEstimate, buildCost, developmentCost } from './development-cost';
import type { Result } from './result';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

function failure<T>(result: Result<T>): { reason: string; missing?: string[] } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result;
}

const inclusions: BuildInclusions = {
  roof: true,
  finishes: true,
  externalWorks: false,
  notes: 'excludes boundary wall and borehole',
};

/** 400 m² × NGN 250,000/m² = NGN 100,000,000. Hypothetical test figures, not market rates. */
const areaRate = {
  grossFloorArea: { value: 400, unit: 'm2' as const },
  approvedBuildRateNgnPerM2: 250_000,
};

/** Hypothetical priced BOQ, deliberately different from the area-rate estimate. */
const boq = { totalNgn: 95_000_000, reference: 'BOQ-2027-04 rev B' };

function input(build: BuildCostInput): DevelopmentCostInput {
  return {
    land: 20_000_000,
    acquisitionCosts: 2_000_000,
    build,
    professionalFees: 5_000_000,
    approvals: 1_000_000,
    utilitiesAndExternalWorks: 3_000_000,
    contingency: { kind: 'amount', amount: 4_000_000 },
    financingDuringBuild: 6_000_000,
  };
}

describe('buildCost', () => {
  it('uses gross floor area × approved rate when only the area rate is supplied', () => {
    const cost = unwrap(buildCost({ areaRate, inclusions }));
    expect(cost.basis).toBe('area_rate');
    expect(cost.amount).toBe(100_000_000);
    expect(cost.areaRate?.grossFloorAreaM2).toBe(400);
    expect(cost.areaRate?.declaredArea).toEqual({ value: 400, unit: 'm2' });
    expect(cost.boq).toBeNull();
    expect(cost.areaRateCrossCheck).toBeNull();
  });

  it('uses the priced BOQ when only the BOQ is supplied', () => {
    const cost = unwrap(buildCost({ boq, inclusions }));
    expect(cost.basis).toBe('boq');
    expect(cost.amount).toBe(95_000_000);
    expect(cost.boq).toEqual({ totalNgn: 95_000_000, reference: 'BOQ-2027-04 rev B' });
    expect(cost.areaRate).toBeNull();
  });

  it('never adds the BOQ to the area-rate estimate when both are supplied', () => {
    const cost = unwrap(buildCost({ areaRate, boq, inclusions }));
    expect(cost.basis).toBe('boq');
    expect(cost.amount).toBe(95_000_000);
    expect(cost.amount).not.toBe(95_000_000 + 100_000_000);
    expect(cost.areaRateCrossCheck).toBe(100_000_000);
  });

  it('passes the inclusions description through so callers can explain scope', () => {
    const cost = unwrap(buildCost({ areaRate, inclusions }));
    expect(cost.inclusions).toEqual(inclusions);
    expect(failure(buildCost({ areaRate } as unknown as BuildCostInput)).missing).toContain(
      'build.inclusions',
    );
  });

  it('fails, naming both bases, when neither an area rate nor a BOQ is supplied', () => {
    const rejected = failure(buildCost({ inclusions }));
    expect(rejected.missing).toEqual(['build.areaRate', 'build.boq']);
    expect(rejected.reason).toMatch(/area-rate estimate .* or a priced BOQ/);
  });

  it('rejects a gross floor area declared in plots and a non-positive build rate', () => {
    const plots = failure(
      buildCost({
        areaRate: {
          grossFloorArea: { value: 1, unit: 'plot' },
          approvedBuildRateNgnPerM2: 250_000,
        },
        inclusions,
      }),
    );
    expect(plots.reason).toMatch(/plot is not a fixed area/);
    const rate = failure(
      areaRateEstimate({
        grossFloorArea: { value: 400, unit: 'm2' },
        approvedBuildRateNgnPerM2: 0,
      }),
    );
    expect(rate.reason).toMatch(/approvedBuildRateNgnPerM2 must be .* greater than zero/);
  });

  it('converts a gross floor area declared in square feet and retains the declaration', () => {
    const cost = unwrap(
      buildCost({
        areaRate: {
          grossFloorArea: { value: 4305.564167, unit: 'sqft' },
          approvedBuildRateNgnPerM2: 250_000,
        },
        inclusions,
      }),
    );
    expect(cost.areaRate?.grossFloorAreaM2).toBeCloseTo(400, 5);
    expect(cost.areaRate?.declaredArea).toEqual({ value: 4305.564167, unit: 'sqft' });
    expect(cost.amount).toBeCloseTo(100_000_000, -1);
  });
});

describe('developmentCost', () => {
  it('sums land, acquisition, build, fees, approvals, utilities, contingency and financing', () => {
    const cost = unwrap(developmentCost(input({ areaRate, inclusions })));
    expect(cost.components).toEqual({
      land: 20_000_000,
      acquisitionCosts: 2_000_000,
      buildCost: 100_000_000,
      professionalFees: 5_000_000,
      approvals: 1_000_000,
      utilitiesAndExternalWorks: 3_000_000,
      contingency: 4_000_000,
      financingDuringBuild: 6_000_000,
    });
    expect(cost.total).toBe(141_000_000);
    expect(cost.build.basis).toBe('area_rate');
    expect(cost.contingency).toEqual({ kind: 'amount', amount: 4_000_000 });
  });

  it('records the BOQ basis and excludes the area-rate estimate from the total', () => {
    const cost = unwrap(developmentCost(input({ areaRate, boq, inclusions })));
    expect(cost.build.basis).toBe('boq');
    expect(cost.components.buildCost).toBe(95_000_000);
    expect(cost.total).toBe(136_000_000);
    expect(cost.build.areaRateCrossCheck).toBe(100_000_000);
  });

  it('applies a fractional contingency to build cost plus professional fees and says so', () => {
    const cost = unwrap(
      developmentCost({
        ...input({ areaRate, inclusions }),
        contingency: { kind: 'fraction_of_build_and_fees', fraction: 0.1 },
      }),
    );
    expect(cost.contingency).toEqual({
      kind: 'fraction_of_build_and_fees',
      fraction: 0.1,
      base: 105_000_000,
      amount: 10_500_000,
    });
    expect(cost.total).toBe(147_500_000);
  });

  it('lists every missing component instead of defaulting it to zero', () => {
    const partial = {
      ...input({ areaRate, inclusions }),
      approvals: undefined,
      financingDuringBuild: undefined,
    } as unknown as DevelopmentCostInput;
    const rejected = failure(developmentCost(partial));
    expect(rejected.missing).toEqual(['approvals', 'financingDuringBuild']);
    expect(rejected.reason).toMatch(/Missing required inputs: approvals, financingDuringBuild/);
  });

  it('carries a build failure (plot area) up to the development cost result', () => {
    const rejected = failure(
      developmentCost(
        input({
          areaRate: {
            grossFloorArea: { value: 2, unit: 'plot' },
            approvedBuildRateNgnPerM2: 250_000,
          },
          inclusions,
        }),
      ),
    );
    expect(rejected.reason).toMatch(/plot is not a fixed area/);
  });

  it('rejects an unknown contingency kind and negative amounts', () => {
    const kind = failure(
      developmentCost({
        ...input({ areaRate, inclusions }),
        contingency: {
          kind: 'percent',
          value: 10,
        } as unknown as DevelopmentCostInput['contingency'],
      }),
    );
    expect(kind.reason).toMatch(/contingency.kind must be/);
    const negative = failure(developmentCost({ ...input({ areaRate, inclusions }), land: -1 }));
    expect(negative.reason).toMatch(/land must be a finite amount of zero or more/);
  });
});
