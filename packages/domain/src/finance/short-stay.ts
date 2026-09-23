import type { CostDenominator } from './denominator';
import { checkDenominator, yieldPercent } from './denominator';
import type { Result } from './result';
import { fail, InputCheck, isPresent, ok } from './result';

/**
 * Stays are needed to cost cleaning: either the average length of stay
 * (stays = occupied nights / length) or an explicit number of stays.
 */
export type StayCountInput = { averageLengthOfStayNights: number } | { numberOfStays: number };

/**
 * Brief §6.4: "Short stays use available nights, occupied-night percentage,
 * nightly rate, platform charges, cleaning and operating costs. Never
 * multiply nightly asking rent by 365 and call it expected revenue."
 * `availableNightsPerYear` is therefore a required explicit input.
 */
export interface ShortStayInput {
  /** Nights the unit is actually offered for letting in the year (0–366). Never assumed to be 365. */
  availableNightsPerYear: number;
  /** Fraction of available nights that are booked (0.6 = 60%). */
  occupiedNightFraction: number;
  /** Achieved nightly rate, whole naira. */
  nightlyRate: number;
  /** Platform/channel charge as a fraction of gross booking revenue. */
  platformChargeFraction: number;
  /** Cleaning and turnover cost per stay, whole naira. */
  cleaningCostPerStay: number;
  stays: StayCountInput;
  /** Annual operating costs other than platform charges and cleaning (power, water, internet, consumables, management), whole naira. */
  annualOperatingCosts: number;
  /** Optional cost basis for yields; without it yields are reported as unavailable. */
  denominator?: CostDenominator | null;
}

export type StayCountBasis = 'average_length_of_stay' | 'number_of_stays';

/**
 * Annual short-stay economics. A distinct type from `LongLetEconomics` so
 * short-stay cohorts are never mixed with annual leases (`kind` differs).
 */
export interface ShortStayEconomics {
  kind: 'short_stay';
  availableNightsPerYear: number;
  occupiedNightFraction: number;
  /** `availableNightsPerYear * occupiedNightFraction` (expected value; may be fractional). */
  occupiedNights: number;
  nightlyRate: number;
  /** `occupiedNights * nightlyRate`. */
  grossBookingRevenue: number;
  platformCharges: number;
  /** `grossBookingRevenue - platformCharges`. */
  netBookingRevenue: number;
  /** Expected number of stays (may be fractional). */
  numberOfStays: number;
  averageLengthOfStayNights: number | null;
  stayCountBasis: StayCountBasis;
  /** `numberOfStays * cleaningCostPerStay`. */
  cleaningCosts: number;
  annualOperatingCosts: number;
  /** `netBookingRevenue - cleaningCosts - annualOperatingCosts`, pre-tax, before debt. */
  netOperatingIncome: number;
  denominator: CostDenominator | null;
  /** `grossBookingRevenue / denominator * 100`. */
  grossYieldPercent: Result<number>;
  /** `netOperatingIncome / denominator * 100`. */
  netYieldPercent: Result<number>;
}

export function shortStayEconomics(
  input: ShortStayInput | null | undefined,
): Result<ShortStayEconomics> {
  if (!isPresent(input)) return fail('Short-stay inputs are required.', ['shortStay']);
  const check = new InputCheck();

  const availableNights = check.amount('availableNightsPerYear', input.availableNightsPerYear);
  if (Number.isFinite(availableNights) && availableNights > 366) {
    check.problem('availableNightsPerYear cannot exceed 366');
  }
  const occupiedFraction = check.fraction('occupiedNightFraction', input.occupiedNightFraction);
  const nightlyRate = check.amount('nightlyRate', input.nightlyRate);
  const platformFraction = check.fraction('platformChargeFraction', input.platformChargeFraction);
  const cleaningPerStay = check.amount('cleaningCostPerStay', input.cleaningCostPerStay);
  const operatingCosts = check.amount('annualOperatingCosts', input.annualOperatingCosts);

  let averageLengthOfStay: number | null = null;
  let explicitStays: number | null = null;
  const stays: unknown = input.stays;
  if (!isPresent(stays) || typeof stays !== 'object') {
    check.absent('stays.averageLengthOfStayNights or stays.numberOfStays');
  } else {
    const candidate = stays as { averageLengthOfStayNights?: unknown; numberOfStays?: unknown };
    const hasLength = isPresent(candidate.averageLengthOfStayNights);
    const hasCount = isPresent(candidate.numberOfStays);
    if (hasLength && hasCount) {
      check.problem(
        'stays was supplied both as an average length of stay and as a number of stays; supply exactly one',
      );
    } else if (hasLength) {
      averageLengthOfStay = check.positive(
        'stays.averageLengthOfStayNights',
        candidate.averageLengthOfStayNights,
      );
    } else if (hasCount) {
      explicitStays = check.amount('stays.numberOfStays', candidate.numberOfStays);
    } else {
      check.absent('stays.averageLengthOfStayNights or stays.numberOfStays');
    }
  }

  const denominator = isPresent(input.denominator)
    ? checkDenominator(check, 'denominator', input.denominator)
    : null;
  if (check.failed) return check.failure();

  const occupiedNights = availableNights * occupiedFraction;
  const grossBookingRevenue = occupiedNights * nightlyRate;
  const platformCharges = grossBookingRevenue * platformFraction;
  const netBookingRevenue = grossBookingRevenue - platformCharges;

  let numberOfStays: number;
  let stayCountBasis: StayCountBasis;
  let lengthOfStay: number | null;
  if (explicitStays !== null) {
    numberOfStays = explicitStays;
    stayCountBasis = 'number_of_stays';
    lengthOfStay = numberOfStays > 0 ? occupiedNights / numberOfStays : null;
  } else {
    lengthOfStay = averageLengthOfStay ?? Number.NaN;
    numberOfStays = occupiedNights / lengthOfStay;
    stayCountBasis = 'average_length_of_stay';
  }
  const cleaningCosts = numberOfStays * cleaningPerStay;
  const netOperatingIncome = netBookingRevenue - cleaningCosts - operatingCosts;

  const noDenominator = (): Result<number> =>
    fail('No yield: no cost denominator was supplied for the short-stay scenario.', [
      'denominator',
    ]);

  return ok({
    kind: 'short_stay',
    availableNightsPerYear: availableNights,
    occupiedNightFraction: occupiedFraction,
    occupiedNights,
    nightlyRate,
    grossBookingRevenue,
    platformCharges,
    netBookingRevenue,
    numberOfStays,
    averageLengthOfStayNights: lengthOfStay,
    stayCountBasis,
    cleaningCosts,
    annualOperatingCosts: operatingCosts,
    netOperatingIncome,
    denominator,
    grossYieldPercent: denominator
      ? yieldPercent(grossBookingRevenue, denominator)
      : noDenominator(),
    netYieldPercent: denominator ? yieldPercent(netOperatingIncome, denominator) : noDenominator(),
  });
}
