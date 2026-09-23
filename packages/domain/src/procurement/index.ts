/**
 * Materials procurement: unit normalisation with explicitly declared
 * conversion factors, delivered-cost comparison of RFQ responses and
 * delivery/discrepancy arithmetic.
 *
 * Nothing here assumes a conversion. A supplier who quotes per "trip" for an
 * RFQ item measured in m³ is only comparable when someone declared how many
 * m³ one trip carries (`supplier_declared`) or staff measured it
 * (`staff_measured`). Otherwise the line is reported as not comparable with
 * reason `unit_conversion_unknown` and the supplier's total stays unknown.
 *
 * Quantities and factors are exact decimals (scaled bigint); money is integer
 * kobo. Rounding happens once, at the final kobo figure, half up.
 */

/* -------------------------------------------------------------------------- */
/* Exact decimals                                                             */
/* -------------------------------------------------------------------------- */

export const DECIMAL_SCALE = 6;
const ONE = 10n ** BigInt(DECIMAL_SCALE);

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`invalid decimal ${String(n)}`);
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(DECIMAL_SCALE) : s;
}

/** Parses "12.5" / 12.5 / 12n into a bigint scaled by 10^6. Throws on malformed input or excess precision. */
export function parseDecimal(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value * ONE;
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new RangeError(`invalid decimal "${String(value)}"`);
  const frac = m[3] ?? '';
  if (frac.length > DECIMAL_SCALE) {
    throw new RangeError(`"${text}" has more than ${DECIMAL_SCALE} decimal places`);
  }
  const scaled = BigInt(m[2] ?? '0') * ONE + BigInt(frac.padEnd(DECIMAL_SCALE, '0') || '0');
  return m[1] ? -scaled : scaled;
}

/** Formats a 10^6-scaled bigint as a plain decimal string without trailing zeros. */
export function formatDecimal(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Integer division rounded half up (away from zero). */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

export function parseKoboValue(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`kobo must be a safe integer: ${value}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value.trim())) throw new RangeError(`invalid kobo "${value}"`);
  return BigInt(value.trim());
}

/* -------------------------------------------------------------------------- */
/* Units                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Spelling aliases only. Every entry maps different spellings of the SAME
 * unit; none of them is a quantity conversion. "ton" is deliberately absent
 * (short ton versus metric tonne is a conversion, not a spelling).
 */
const UNIT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['m3', 'm3'],
  ['m³', 'm3'],
  ['cubic metre', 'm3'],
  ['cubic metres', 'm3'],
  ['cubic meter', 'm3'],
  ['cubic meters', 'm3'],
  ['cum', 'm3'],
  ['m2', 'm2'],
  ['m²', 'm2'],
  ['square metre', 'm2'],
  ['square metres', 'm2'],
  ['square meter', 'm2'],
  ['square meters', 'm2'],
  ['sqm', 'm2'],
  ['m', 'm'],
  ['metre', 'm'],
  ['metres', 'm'],
  ['meter', 'm'],
  ['meters', 'm'],
  ['kg', 'kg'],
  ['kilogram', 'kg'],
  ['kilograms', 'kg'],
  ['tonne', 'tonne'],
  ['tonnes', 'tonne'],
  ['bag', 'bag'],
  ['bags', 'bag'],
  ['piece', 'piece'],
  ['pieces', 'piece'],
  ['pc', 'piece'],
  ['pcs', 'piece'],
  ['each', 'piece'],
  ['ea', 'piece'],
  ['trip', 'trip'],
  ['trips', 'trip'],
  ['length', 'length'],
  ['lengths', 'length'],
  ['litre', 'litre'],
  ['litres', 'litre'],
  ['liter', 'litre'],
  ['liters', 'litre'],
  ['sheet', 'sheet'],
  ['sheets', 'sheet'],
  ['roll', 'roll'],
  ['rolls', 'roll'],
  ['set', 'set'],
  ['sets', 'set'],
  ['lot', 'lot'],
  ['lots', 'lot'],
]);

/** Canonical spelling of a unit label; unknown labels come back lower-cased and trimmed. */
export function canonicalUnit(unit: string): string {
  const key = unit.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  return UNIT_ALIASES.get(key) ?? key;
}

export type ConversionBasis = 'supplier_declared' | 'staff_measured';

/** "1 fromUnit = factor toUnit", stated by a named party. */
export interface DeclaredConversion {
  fromUnit: string;
  toUnit: string;
  factor: string | number;
  basis: ConversionBasis;
}

export interface ResolvedConversion {
  fromUnit: string;
  toUnit: string;
  /** Exact ratio: 1 fromUnit = (numerator / denominator) toUnit. */
  numerator: bigint;
  denominator: bigint;
  basis: ConversionBasis | 'identity';
  direction: 'identity' | 'declared' | 'inverted';
}

export type ConversionReason = 'unit_conversion_unknown' | 'invalid_factor';

export type ConversionResolution =
  | { ok: true; conversion: ResolvedConversion }
  | { ok: false; reason: ConversionReason; message: string };

/**
 * Resolves how to express `fromUnit` quantities in `toUnit`. Identity when
 * the units are the same (after spelling normalisation); otherwise only a
 * declared conversion between exactly these two units (either direction) is
 * accepted. Anything else is unknown, never guessed.
 */
export function resolveConversion(
  fromUnit: string,
  toUnit: string,
  declared?: DeclaredConversion | null,
): ConversionResolution {
  const from = canonicalUnit(fromUnit);
  const to = canonicalUnit(toUnit);
  if (from === to) {
    return {
      ok: true,
      conversion: { fromUnit: from, toUnit: to, numerator: 1n, denominator: 1n, basis: 'identity', direction: 'identity' },
    };
  }
  if (!declared) {
    return {
      ok: false,
      reason: 'unit_conversion_unknown',
      message: `no declared conversion between ${from} and ${to}`,
    };
  }
  let factor: bigint;
  try {
    factor = parseDecimal(declared.factor);
  } catch {
    return { ok: false, reason: 'invalid_factor', message: `conversion factor "${String(declared.factor)}" is not a decimal` };
  }
  if (factor <= 0n) {
    return { ok: false, reason: 'invalid_factor', message: 'conversion factor must be positive' };
  }
  const dFrom = canonicalUnit(declared.fromUnit);
  const dTo = canonicalUnit(declared.toUnit);
  if (dFrom === from && dTo === to) {
    return {
      ok: true,
      conversion: { fromUnit: from, toUnit: to, numerator: factor, denominator: ONE, basis: declared.basis, direction: 'declared' },
    };
  }
  if (dFrom === to && dTo === from) {
    return {
      ok: true,
      conversion: { fromUnit: from, toUnit: to, numerator: ONE, denominator: factor, basis: declared.basis, direction: 'inverted' },
    };
  }
  return {
    ok: false,
    reason: 'unit_conversion_unknown',
    message: `declared conversion ${dFrom}→${dTo} does not relate ${from} and ${to}`,
  };
}

export type QuantityConversion =
  | { ok: true; quantity: string; conversion: ResolvedConversion }
  | { ok: false; reason: ConversionReason | 'invalid_quantity'; message: string };

/** Expresses a quantity in another unit, only through an identity or a declared factor. */
export function convertQuantity(input: {
  quantity: string | number;
  fromUnit: string;
  toUnit: string;
  declaredConversion?: DeclaredConversion | null;
}): QuantityConversion {
  let qty: bigint;
  try {
    qty = parseDecimal(input.quantity);
  } catch {
    return { ok: false, reason: 'invalid_quantity', message: `quantity "${String(input.quantity)}" is not a decimal` };
  }
  const resolved = resolveConversion(input.fromUnit, input.toUnit, input.declaredConversion);
  if (!resolved.ok) return resolved;
  const { numerator, denominator } = resolved.conversion;
  const converted = divideRoundHalfUp(qty * numerator, denominator);
  return { ok: true, quantity: formatDecimal(converted), conversion: resolved.conversion };
}

/* -------------------------------------------------------------------------- */
/* Delivered-cost comparison                                                  */
/* -------------------------------------------------------------------------- */

export interface RfqItemSpec {
  itemId: string;
  material: string;
  specification: string;
  /** Unit the buyer measures the item in. */
  unit: string;
  /** Quantity required, in `unit`. */
  quantity: string;
}

export interface ResponseLineInput {
  itemId: string;
  /** Price per `quantityUnit`, integer kobo. */
  unitPriceKobo: bigint | string | number;
  /** Unit the supplier priced (may differ from the RFQ unit). */
  quantityUnit: string;
  declaredConversion?: DeclaredConversion | null;
  leadTimeDays?: number | null;
  note?: string | null;
}

export interface ResponseInput {
  responseId: string;
  supplierLabel: string;
  currency: string;
  /** Delivery to the RFQ address, integer kobo; null when the supplier did not state it. */
  deliveryKobo: bigint | string | number | null;
  lines: ResponseLineInput[];
  leadTimeDays?: number | null;
  validUntil?: string | null;
}

export type LineIncomparabilityReason =
  | 'unit_conversion_unknown'
  | 'invalid_factor'
  | 'line_missing'
  | 'invalid_price'
  | 'currency_mismatch';

export interface ComparisonLine {
  itemId: string;
  comparable: boolean;
  reason: LineIncomparabilityReason | null;
  message: string | null;
  rfqUnit: string;
  rfqQuantity: string;
  supplierUnit: string | null;
  /** Price per supplier unit as quoted. */
  supplierUnitPriceKobo: string | null;
  /** Supplier units needed to cover the RFQ quantity (exact decimal), when comparable. */
  supplierUnitsRequired: string | null;
  /** Quoted price expressed per RFQ unit, rounded to kobo; informational only. */
  normalizedUnitPriceKobo: string | null;
  /** Goods cost of the RFQ quantity, rounded once to kobo. */
  lineTotalKobo: string | null;
  conversion: {
    fromUnit: string;
    toUnit: string;
    factor: string;
    basis: ConversionBasis | 'identity';
  } | null;
  /** Set when the RFQ quantity is not a whole number of supplier units (pro-rata cost shown). */
  partialSupplierUnit: boolean;
  leadTimeDays: number | null;
  note: string | null;
}

export interface ComparisonEntry {
  responseId: string;
  supplierLabel: string;
  currency: string;
  lines: ComparisonLine[];
  comparableLines: number;
  totalLines: number;
  fullyComparable: boolean;
  /** Sum of the comparable lines only (a lower bound, never a total, when lines are unknown). */
  comparableGoodsKobo: string;
  goodsKobo: string | null;
  deliveryKobo: string | null;
  /** Goods + delivery; null whenever any line or the delivery cost is unknown. */
  totalDeliveredKobo: string | null;
  unknowns: Array<{ itemId: string | null; reason: LineIncomparabilityReason | 'delivery_unknown'; message: string }>;
  rank: number | null;
  leadTimeDays: number | null;
  validUntil: string | null;
}

export interface ComparisonResult {
  currency: string;
  items: RfqItemSpec[];
  entries: ComparisonEntry[];
  /** Response ids in rank order (fully comparable responses only). */
  ranked: string[];
  note: string;
}

export const COMPARISON_NOTE =
  'Totals compare goods plus stated delivery for the RFQ quantities. Lines priced in a different unit are converted only through a declared factor; unknown conversions and unstated delivery costs are shown as unknown, never estimated.';

function compareLine(item: RfqItemSpec, line: ResponseLineInput | undefined, currencyOk: boolean): ComparisonLine {
  const base: ComparisonLine = {
    itemId: item.itemId,
    comparable: false,
    reason: null,
    message: null,
    rfqUnit: canonicalUnit(item.unit),
    rfqQuantity: item.quantity,
    supplierUnit: null,
    supplierUnitPriceKobo: null,
    supplierUnitsRequired: null,
    normalizedUnitPriceKobo: null,
    lineTotalKobo: null,
    conversion: null,
    partialSupplierUnit: false,
    leadTimeDays: null,
    note: null,
  };
  if (!line) return { ...base, reason: 'line_missing', message: 'the supplier did not price this item' };
  base.supplierUnit = canonicalUnit(line.quantityUnit);
  base.leadTimeDays = line.leadTimeDays ?? null;
  base.note = line.note ?? null;
  let price: bigint;
  try {
    price = parseKoboValue(line.unitPriceKobo);
  } catch {
    return { ...base, reason: 'invalid_price', message: 'unit price is not integer kobo' };
  }
  if (price < 0n) return { ...base, reason: 'invalid_price', message: 'unit price cannot be negative' };
  base.supplierUnitPriceKobo = price.toString();
  if (!currencyOk) {
    return { ...base, reason: 'currency_mismatch', message: 'response currency differs from the RFQ currency' };
  }
  // Conversion from the supplier's unit to the RFQ unit: 1 supplierUnit = n/d rfqUnits.
  const resolved = resolveConversion(line.quantityUnit, item.unit, line.declaredConversion);
  if (!resolved.ok) return { ...base, reason: resolved.reason, message: resolved.message };
  const { numerator, denominator } = resolved.conversion;
  let qty: bigint;
  try {
    qty = parseDecimal(item.quantity);
  } catch {
    return { ...base, reason: 'line_missing', message: 'RFQ quantity is not a decimal' };
  }
  // supplier units required = qty * d / n ; cost = price * qty * d / n ; per RFQ unit = price * d / n
  const unitsScaled = divideRoundHalfUp(qty * denominator, numerator);
  const wholeUnits = (qty * denominator) % numerator === 0n && unitsScaled % ONE === 0n;
  const lineTotal = divideRoundHalfUp(price * qty * denominator, numerator * ONE);
  const normalizedUnitPrice = divideRoundHalfUp(price * denominator, numerator);
  const factor =
    resolved.conversion.direction === 'identity'
      ? '1'
      : formatDecimal(divideRoundHalfUp(numerator * ONE, denominator));
  return {
    ...base,
    comparable: true,
    supplierUnitsRequired: formatDecimal(unitsScaled),
    normalizedUnitPriceKobo: normalizedUnitPrice.toString(),
    lineTotalKobo: lineTotal.toString(),
    conversion: {
      fromUnit: resolved.conversion.fromUnit,
      toUnit: resolved.conversion.toUnit,
      factor,
      basis: resolved.conversion.basis,
    },
    partialSupplierUnit: !wholeUnits,
  };
}

/**
 * Compares total delivered cost (goods for the RFQ quantities plus delivery)
 * per supplier. Only fully comparable responses are ranked; the rest keep
 * `rank: null` and list exactly what is unknown.
 */
export function compareDeliveredCost(
  items: RfqItemSpec[],
  responses: ResponseInput[],
  options: { currency?: string } = {},
): ComparisonResult {
  const currency = options.currency ?? responses[0]?.currency ?? 'NGN';
  const entries: ComparisonEntry[] = responses.map((response) => {
    const currencyOk = response.currency === currency;
    const byItem = new Map(response.lines.map((l) => [l.itemId, l]));
    const lines = items.map((item) => compareLine(item, byItem.get(item.itemId), currencyOk));
    const comparable = lines.filter((l) => l.comparable);
    const comparableGoods = comparable.reduce((sum, l) => sum + BigInt(l.lineTotalKobo as string), 0n);
    const unknowns: ComparisonEntry['unknowns'] = lines
      .filter((l) => !l.comparable)
      .map((l) => ({ itemId: l.itemId, reason: l.reason as LineIncomparabilityReason, message: l.message ?? '' }));
    let delivery: bigint | null = null;
    if (response.deliveryKobo !== null && response.deliveryKobo !== undefined) {
      try {
        delivery = parseKoboValue(response.deliveryKobo);
      } catch {
        delivery = null;
      }
    }
    if (delivery === null) {
      unknowns.push({ itemId: null, reason: 'delivery_unknown', message: 'delivery cost not stated' });
    }
    const fullyComparable = unknowns.length === 0 && items.length > 0;
    const goods = comparable.length === items.length && items.length > 0 ? comparableGoods : null;
    return {
      responseId: response.responseId,
      supplierLabel: response.supplierLabel,
      currency: response.currency,
      lines,
      comparableLines: comparable.length,
      totalLines: items.length,
      fullyComparable,
      comparableGoodsKobo: comparableGoods.toString(),
      goodsKobo: goods === null ? null : goods.toString(),
      deliveryKobo: delivery === null ? null : delivery.toString(),
      totalDeliveredKobo: fullyComparable && goods !== null && delivery !== null ? (goods + delivery).toString() : null,
      unknowns,
      rank: null,
      leadTimeDays: response.leadTimeDays ?? null,
      validUntil: response.validUntil ?? null,
    };
  });
  const ranked = entries
    .filter((e) => e.totalDeliveredKobo !== null)
    .sort((a, b) => {
      const ta = BigInt(a.totalDeliveredKobo as string);
      const tb = BigInt(b.totalDeliveredKobo as string);
      if (ta !== tb) return ta < tb ? -1 : 1;
      const la = a.leadTimeDays ?? Number.MAX_SAFE_INTEGER;
      const lb = b.leadTimeDays ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      return a.responseId < b.responseId ? -1 : a.responseId > b.responseId ? 1 : 0;
    });
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return { currency, items, entries, ranked: ranked.map((e) => e.responseId), note: COMPARISON_NOTE };
}

/* -------------------------------------------------------------------------- */
/* Deliveries and discrepancies                                               */
/* -------------------------------------------------------------------------- */

export interface OrderedLine {
  lineId: string;
  quantity: string;
  unitPriceKobo?: bigint | string | number | null;
}

export interface ReceivedLine {
  lineId: string;
  quantityReceived: string;
}

export type LineDeliveryStatus = 'not_received' | 'short' | 'complete' | 'over';

export interface LineVariance {
  lineId: string;
  ordered: string;
  received: string;
  /** Ordered minus received, floored at zero. */
  outstanding: string;
  /** Received beyond the order, floored at zero. */
  excess: string;
  status: LineDeliveryStatus;
  /** Value of the outstanding quantity at the order's unit price, when known. */
  outstandingValueKobo: string | null;
}

export type DeliveryProgressStatus = 'pending' | 'partially_delivered' | 'delivered';

export interface DeliveryVariance {
  lines: LineVariance[];
  status: DeliveryProgressStatus;
}

/**
 * Ordered versus received per line across every delivery recorded so far
 * (receipts for the same line are summed). `delivered` requires every line
 * to be complete or over; anything received short of that is partial.
 */
export function deliveryVariance(ordered: OrderedLine[], received: ReceivedLine[]): DeliveryVariance {
  const receivedByLine = new Map<string, bigint>();
  for (const r of received) {
    receivedByLine.set(r.lineId, (receivedByLine.get(r.lineId) ?? 0n) + parseDecimal(r.quantityReceived));
  }
  const lines = ordered.map((o): LineVariance => {
    const orderedQty = parseDecimal(o.quantity);
    const receivedQty = receivedByLine.get(o.lineId) ?? 0n;
    const outstanding = orderedQty > receivedQty ? orderedQty - receivedQty : 0n;
    const excess = receivedQty > orderedQty ? receivedQty - orderedQty : 0n;
    const status: LineDeliveryStatus =
      receivedQty === 0n && orderedQty > 0n
        ? 'not_received'
        : outstanding > 0n
          ? 'short'
          : excess > 0n
            ? 'over'
            : 'complete';
    const price = o.unitPriceKobo === null || o.unitPriceKobo === undefined ? null : parseKoboValue(o.unitPriceKobo);
    return {
      lineId: o.lineId,
      ordered: formatDecimal(orderedQty),
      received: formatDecimal(receivedQty),
      outstanding: formatDecimal(outstanding),
      excess: formatDecimal(excess),
      status,
      outstandingValueKobo: price === null ? null : divideRoundHalfUp(outstanding * price, ONE).toString(),
    };
  });
  const anyReceived = lines.some((l) => l.status !== 'not_received');
  const allDone = lines.length > 0 && lines.every((l) => l.status === 'complete' || l.status === 'over');
  return { lines, status: allDone ? 'delivered' : anyReceived ? 'partially_delivered' : 'pending' };
}

/** Value of a discrepancy quantity at the line's unit price (short delivery, damaged, wrong spec). */
export function discrepancyValueKobo(input: { quantity: string | number; unitPriceKobo: bigint | string | number }): bigint {
  const qty = parseDecimal(input.quantity);
  if (qty < 0n) throw new RangeError('discrepancy quantity cannot be negative');
  return divideRoundHalfUp(qty * parseKoboValue(input.unitPriceKobo), ONE);
}

/** Purchase-order status implied by the delivery progress (issued/acknowledged stay as they are while pending). */
export function purchaseOrderStatusAfterDelivery(
  progress: DeliveryProgressStatus,
): 'partially_delivered' | 'delivered' | null {
  if (progress === 'delivered') return 'delivered';
  if (progress === 'partially_delivered') return 'partially_delivered';
  return null;
}
