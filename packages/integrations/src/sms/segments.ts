/**
 * SMS segment estimation (GSM 03.38 7-bit vs UCS-2) and cost estimation.
 *
 * A message that fits the GSM-7 basic set is 160 characters per single
 * segment and 153 per part when concatenated (6 bytes of UDH). Any other
 * character forces UCS-2: 70 per single segment, 67 per part. GSM-7
 * extension characters (`^{}\[~]|€` and form feed) cost two septets.
 */

export type SmsEncoding = 'gsm7' | 'ucs2';

export const GSM7_SINGLE_SEGMENT = 160;
export const GSM7_MULTIPART_SEGMENT = 153;
export const UCS2_SINGLE_SEGMENT = 70;
export const UCS2_MULTIPART_SEGMENT = 67;

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '\f^{}\\[~]|€';

const BASIC_SET = new Set(Array.from(GSM7_BASIC));
const EXTENSION_SET = new Set(Array.from(GSM7_EXTENSION));

export interface SegmentEstimate {
  encoding: SmsEncoding;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  unitsPerSegment: number;
  /** Units still available in the last segment before another one is needed. */
  remainingInSegment: number;
  /** Code points in the body (what a person would count). */
  characters: number;
}

export function detectEncoding(body: string): SmsEncoding {
  for (const ch of body) {
    if (!BASIC_SET.has(ch) && !EXTENSION_SET.has(ch)) return 'ucs2';
  }
  return 'gsm7';
}

export function analyzeSegments(body: string): SegmentEstimate {
  const chars = Array.from(body);
  const encoding = detectEncoding(body);
  let units: number;
  if (encoding === 'gsm7') {
    units = 0;
    for (const ch of chars) units += EXTENSION_SET.has(ch) ? 2 : 1;
  } else {
    units = body.length;
  }
  const single = encoding === 'gsm7' ? GSM7_SINGLE_SEGMENT : UCS2_SINGLE_SEGMENT;
  const multi = encoding === 'gsm7' ? GSM7_MULTIPART_SEGMENT : UCS2_MULTIPART_SEGMENT;
  let segments: number;
  let unitsPerSegment: number;
  if (units === 0) {
    segments = 0;
    unitsPerSegment = single;
  } else if (units <= single) {
    segments = 1;
    unitsPerSegment = single;
  } else {
    segments = Math.ceil(units / multi);
    unitsPerSegment = multi;
  }
  const capacity = segments === 0 ? single : segments * unitsPerSegment;
  return {
    encoding,
    units,
    segments,
    unitsPerSegment,
    remainingInSegment: capacity - units,
    characters: chars.length,
  };
}

export function countSegments(body: string): number {
  return analyzeSegments(body).segments;
}

export interface CostEstimateInput {
  segments: number;
  /** Price per segment in integer kobo (from the admin "sending cost" setting). */
  unitCostKobo: number;
  recipients?: number;
}

export interface CostEstimate {
  segments: number;
  recipients: number;
  unitCostKobo: number;
  totalKobo: number;
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const segments = Math.max(0, Math.floor(input.segments));
  const recipients = Math.max(0, Math.floor(input.recipients ?? 1));
  const unitCostKobo = Math.max(0, Math.round(input.unitCostKobo));
  return {
    segments,
    recipients,
    unitCostKobo,
    totalKobo: segments * recipients * unitCostKobo,
  };
}

/** Convenience: segments and cost for a body in one call. */
export function estimateMessageCost(
  body: string,
  unitCostKobo: number,
  recipients = 1,
): SegmentEstimate & CostEstimate {
  const estimate = analyzeSegments(body);
  return {
    ...estimate,
    ...estimateCost({ segments: estimate.segments, unitCostKobo, recipients }),
  };
}
