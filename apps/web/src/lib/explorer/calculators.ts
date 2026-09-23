import { z } from 'zod';

/**
 * Normalises the response of POST /api/v1/calculators/run into a stable shape
 * the scenario builder can render. The endpoint returns the domain
 * calculators' results (each `{ ok: true, value }` or `{ ok: false, reason }`),
 * but its exact key names are owned by the API; this reader tolerates
 * camel/snake case, a `result`/`results` wrapper and per-set nesting, and
 * turns any unrecognised value into an honest `{ ok: false }` rather than a
 * number that was never computed.
 */

export type CalcResult<T> =
  { ok: true; value: T } | { ok: false; reason: string; missing: string[] };

export const failed = <T>(reason: string, missing: string[] = []): CalcResult<T> => ({
  ok: false,
  reason,
  missing,
});

const numberResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.number() }),
  z.object({ ok: z.literal(false), reason: z.string(), missing: z.array(z.string()).optional() }),
]);

const toNumberResult = (raw: z.infer<typeof numberResultSchema> | undefined): CalcResult<number> =>
  raw === undefined
    ? failed('Not computed.')
    : raw.ok
      ? { ok: true, value: raw.value }
      : failed(raw.reason, raw.missing ?? []);

const developmentCostViewSchema = z.object({
  total: z.number(),
  components: z.object({
    land: z.number(),
    acquisitionCosts: z.number(),
    buildCost: z.number(),
    professionalFees: z.number(),
    approvals: z.number(),
    utilitiesAndExternalWorks: z.number(),
    contingency: z.number(),
    financingDuringBuild: z.number(),
  }),
  build: z.object({
    basis: z.enum(['area_rate', 'boq']),
    amount: z.number(),
    inclusions: z
      .object({
        roof: z.boolean(),
        finishes: z.boolean(),
        externalWorks: z.boolean(),
        notes: z.string().optional(),
      })
      .optional(),
    areaRateCrossCheck: z.number().nullable().optional(),
  }),
  contingency: z.object({ kind: z.string(), amount: z.number() }).optional(),
});
export type DevelopmentCostView = z.infer<typeof developmentCostViewSchema>;

const longLetViewSchema = z.object({
  scheduledAnnualRent: z.number(),
  vacancyLoss: z.number().optional(),
  collectionLoss: z.number().optional(),
  effectiveRentalIncome: z.number().optional(),
  effectiveIncome: z.number(),
  operatingExpenses: z.object({
    total: z.number(),
    managementFee: z.number().optional(),
    managementFeeBasis: z.string().optional(),
  }),
  noi: z.number(),
  capexReserve: z.number().optional(),
  capexReserveTreatment: z.string().optional(),
  noiAfterCapexReserve: z.number().nullable().optional(),
  noiBasis: z.string().optional(),
  tax: z.object({ amount: z.number() }).optional(),
  noiAfterTax: z.number().optional(),
  annualDebtService: z.number(),
  cashFlowAfterDebt: z.number(),
  cashFlowAfterDebtAfterTax: z.number().optional(),
  denominator: z.object({ kind: z.string(), amount: z.number() }),
  grossYieldPercent: numberResultSchema,
  netYieldPercent: numberResultSchema,
  equity: z.number().nullable().optional(),
  cashOnCashPercent: numberResultSchema.optional(),
  simplePaybackYears: numberResultSchema,
});
export type LongLetView = z.infer<typeof longLetViewSchema>;

const shortStayViewSchema = z.object({
  availableNightsPerYear: z.number(),
  occupiedNightFraction: z.number(),
  occupiedNights: z.number(),
  nightlyRate: z.number(),
  grossBookingRevenue: z.number(),
  platformCharges: z.number(),
  netBookingRevenue: z.number(),
  numberOfStays: z.number(),
  cleaningCosts: z.number(),
  annualOperatingCosts: z.number(),
  netOperatingIncome: z.number(),
  denominator: z.object({ kind: z.string(), amount: z.number() }).nullable().optional(),
  grossYieldPercent: numberResultSchema,
  netYieldPercent: numberResultSchema,
});
export type ShortStayView = z.infer<typeof shortStayViewSchema>;

const yearMonthSchema = z.object({ year: z.number(), month: z.number() });

const phasingViewSchema = z.object({
  schedule: z.object({
    constructionDurationMonths: z.number(),
    completionDelayMonths: z.number(),
    rentalStartIndex: z.number(),
    plannedRentalStartIndex: z.number().optional(),
    constructionStart: yearMonthSchema.optional(),
    plannedCompletion: yearMonthSchema.optional(),
    rentalStart: yearMonthSchema.optional(),
  }),
  stabilisationIndex: z.number().optional(),
  months: z.array(
    z.object({
      index: z.number(),
      year: z.number().optional(),
      month: z.number().optional(),
      phase: z.string(),
      occupancyFraction: z.number().optional(),
      constructionSpend: z.number(),
      rentalIncome: z.number(),
      operatingExpenses: z.number(),
      netCashFlow: z.number(),
      cumulativeNetCashFlow: z.number(),
    }),
  ),
  totals: z
    .object({
      constructionSpend: z.number(),
      rentalIncome: z.number(),
      operatingExpenses: z.number(),
      netCashFlow: z.number(),
    })
    .optional(),
});
export type PhasingView = z.infer<typeof phasingViewSchema>;

const npvViewSchema = z.object({
  npv: z.number(),
  discountRate: z.number(),
  finalPeriod: z.number().optional(),
  netExitProceeds: z.number().optional(),
});
export type NpvView = z.infer<typeof npvViewSchema>;

const irrViewSchema = z.object({
  irr: z.number(),
  uniqueness: z.string().optional(),
  signChanges: z.number().optional(),
});
export type IrrView = z.infer<typeof irrViewSchema>;

const sensitivityOutcomeSchema = z.object({
  netYieldPercent: numberResultSchema,
  grossYieldPercent: numberResultSchema.optional(),
  noi: z.number(),
  cashFlowAfterDebt: z.number(),
  rentDeferredDuringDelay: z.number().optional(),
});

const sensitivityCellSchema = z.object({
  variable: z.string(),
  value: z.number(),
  outcome: z.union([
    z.object({ ok: z.literal(true), value: sensitivityOutcomeSchema }),
    z.object({ ok: z.literal(false), reason: z.string(), missing: z.array(z.string()).optional() }),
  ]),
});
export type SensitivityCellView = z.infer<typeof sensitivityCellSchema>;

export const SENSITIVITY_VARIABLES = [
  'vacancy',
  'rents',
  'costs',
  'interest',
  'completionDelayMonths',
] as const;
export type SensitivityVariable = (typeof SENSITIVITY_VARIABLES)[number];

const sensitivityViewSchema = z.object({
  vacancy: z.array(sensitivityCellSchema).default([]),
  rents: z.array(sensitivityCellSchema).default([]),
  costs: z.array(sensitivityCellSchema).default([]),
  interest: z.array(sensitivityCellSchema).default([]),
  completionDelayMonths: z.array(sensitivityCellSchema).default([]),
});
export type SensitivityView = z.infer<typeof sensitivityViewSchema>;

export interface CalculatorSets {
  low: CalcResult<LongLetView>;
  base: CalcResult<LongLetView>;
  high: CalcResult<LongLetView>;
}

export interface CalculatorRunResult {
  developmentCost: CalcResult<DevelopmentCostView>;
  longLet: CalcResult<LongLetView>;
  shortStay: CalcResult<ShortStayView>;
  phasing: CalcResult<PhasingView>;
  npv: CalcResult<NpvView>;
  irr: CalcResult<IrrView>;
  sensitivity: CalcResult<SensitivityView>;
  sets: CalculatorSets | null;
  disclaimer: string | null;
  /** True when nothing recognisable came back at all. */
  empty: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Finds a property by any of several candidate names, tolerant of case and separators. */
export function pickKey(record: Record<string, unknown>, candidates: readonly string[]): unknown {
  const wanted = candidates.map(normaliseKey);
  for (const [key, value] of Object.entries(record)) {
    if (wanted.includes(normaliseKey(key))) return value;
  }
  return undefined;
}

function toResult<T>(raw: unknown, schema: z.ZodType<T>, what: string): CalcResult<T> {
  if (raw === undefined || raw === null)
    return failed(`${what} was not returned by the calculator service.`);
  if (!isRecord(raw)) return failed(`${what} came back in an unexpected shape.`);
  if (raw.ok === false) {
    const reason = typeof raw.reason === 'string' ? raw.reason : `${what} could not be computed.`;
    const missing = Array.isArray(raw.missing)
      ? raw.missing.filter((m): m is string => typeof m === 'string')
      : [];
    return failed(reason, missing);
  }
  // Accept both `{ ok: true, value }` and a bare value object.
  const candidate = raw.ok === true ? raw.value : raw;
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) return failed(`${what} came back in an unexpected shape.`);
  return { ok: true, value: parsed.data };
}

const KEYS = {
  wrapper: ['result', 'results', 'calculators', 'data'],
  developmentCost: ['developmentCost', 'development_cost', 'totalDevelopmentCost', 'cost'],
  longLet: ['longLet', 'long_let', 'longLetEconomics', 'rental', 'economics'],
  shortStay: ['shortStay', 'short_stay', 'shortStayEconomics'],
  phasing: ['phasing', 'monthlyPhasing', 'cashFlow', 'cash_flow'],
  npv: ['npv'],
  irr: ['irr'],
  npvIrr: ['npvIrr', 'npv_irr'],
  sensitivity: ['sensitivity', 'sensitivityGrid', 'sensitivity_grid'],
  sets: ['scenarioSets', 'scenario_sets', 'sets'],
  disclaimer: ['disclaimer', 'notice'],
} as const;

function bundleFrom(record: Record<string, unknown>): Record<string, unknown> {
  const wrapped = pickKey(record, KEYS.wrapper);
  return isRecord(wrapped) ? wrapped : record;
}

function looksLikeBundle(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    pickKey(value, KEYS.developmentCost) !== undefined ||
    pickKey(value, KEYS.longLet) !== undefined ||
    pickKey(value, KEYS.shortStay) !== undefined
  );
}

function readLongLet(bundle: Record<string, unknown>): CalcResult<LongLetView> {
  return toResult(pickKey(bundle, KEYS.longLet), longLetViewSchema, 'Long-let economics');
}

function readSets(
  bundle: Record<string, unknown>,
  baseBundle: Record<string, unknown>,
): CalculatorSets | null {
  const raw = pickKey(bundle, KEYS.sets);
  const setsRecord = isRecord(raw) ? raw : null;
  const readSet = (name: 'low' | 'base' | 'high'): CalcResult<LongLetView> | null => {
    const fromSets = setsRecord ? setsRecord[name] : undefined;
    if (fromSets !== undefined) {
      return looksLikeBundle(fromSets)
        ? readLongLet(fromSets)
        : toResult(fromSets, longLetViewSchema, `${name} set`);
    }
    const nested = bundle[name];
    if (looksLikeBundle(nested)) return readLongLet(nested);
    return null;
  };
  const low = readSet('low');
  const base = readSet('base') ?? readLongLet(baseBundle);
  const high = readSet('high');
  if (low === null && high === null && setsRecord === null) return null;
  return {
    low: low ?? failed('No low set was supplied.'),
    base,
    high: high ?? failed('No high set was supplied.'),
  };
}

export function normalizeCalculatorResponse(raw: unknown): CalculatorRunResult {
  if (!isRecord(raw)) return emptyCalculatorResult('The calculator service returned no results.');
  const top = bundleFrom(raw);
  // Per-set nesting: { base: {...bundle}, low: {...}, high: {...} }
  const baseBundle = looksLikeBundle(top.base) ? top.base : top;
  const npvIrr = pickKey(baseBundle, KEYS.npvIrr);
  const npvRaw =
    pickKey(baseBundle, KEYS.npv) ?? (isRecord(npvIrr) ? pickKey(npvIrr, KEYS.npv) : undefined);
  const irrRaw =
    pickKey(baseBundle, KEYS.irr) ?? (isRecord(npvIrr) ? pickKey(npvIrr, KEYS.irr) : undefined);
  const disclaimer = pickKey(top, KEYS.disclaimer);

  const result: CalculatorRunResult = {
    developmentCost: toResult(
      pickKey(baseBundle, KEYS.developmentCost),
      developmentCostViewSchema,
      'Development cost',
    ),
    longLet: readLongLet(baseBundle),
    shortStay: toResult(
      pickKey(baseBundle, KEYS.shortStay),
      shortStayViewSchema,
      'Short-stay economics',
    ),
    phasing: toResult(pickKey(baseBundle, KEYS.phasing), phasingViewSchema, 'Monthly phasing'),
    npv: toResult(npvRaw, npvViewSchema, 'NPV'),
    irr: toResult(irrRaw, irrViewSchema, 'IRR'),
    sensitivity: toResult(
      pickKey(top, KEYS.sensitivity) ?? pickKey(baseBundle, KEYS.sensitivity),
      sensitivityViewSchema,
      'Sensitivity',
    ),
    sets: readSets(top, baseBundle),
    disclaimer: typeof disclaimer === 'string' ? disclaimer : null,
    empty: false,
  };
  const anyRecognised =
    result.developmentCost.ok ||
    result.longLet.ok ||
    result.shortStay.ok ||
    result.phasing.ok ||
    result.sensitivity.ok ||
    pickKey(baseBundle, KEYS.developmentCost) !== undefined ||
    pickKey(baseBundle, KEYS.longLet) !== undefined;
  result.empty = !anyRecognised;
  return result;
}

export function emptyCalculatorResult(reason: string): CalculatorRunResult {
  return {
    developmentCost: failed(reason),
    longLet: failed(reason),
    shortStay: failed(reason),
    phasing: failed(reason),
    npv: failed(reason),
    irr: failed(reason),
    sensitivity: failed(reason),
    sets: null,
    disclaimer: null,
    empty: true,
  };
}

/** Points for one sensitivity dimension: x = the varied value, y = net yield % (null when unavailable). */
export function sensitivitySeries(cells: readonly SensitivityCellView[]): Array<{
  x: number;
  netYield: number | null;
  cashFlowAfterDebt: number | null;
  reason: string | null;
}> {
  return cells.map((cell) => {
    if (!cell.outcome.ok) {
      return {
        x: cell.value,
        netYield: null,
        cashFlowAfterDebt: null,
        reason: cell.outcome.reason,
      };
    }
    const yieldResult = toNumberResult(cell.outcome.value.netYieldPercent);
    return {
      x: cell.value,
      netYield: yieldResult.ok ? yieldResult.value : null,
      cashFlowAfterDebt: cell.outcome.value.cashFlowAfterDebt,
      reason: yieldResult.ok ? null : yieldResult.reason,
    };
  });
}

export function numberResult(
  raw: z.infer<typeof numberResultSchema> | undefined,
): CalcResult<number> {
  return toNumberResult(raw);
}
