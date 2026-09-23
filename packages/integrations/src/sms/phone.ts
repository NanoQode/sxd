import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/**
 * Phone number normalisation. Everything stored or sent is E.164
 * (`+2348012345678`). Termii wants the same digits without the `+`
 * (research note B.10: every official sample is `234…`).
 *
 * The `max` metadata build is used so number types are known for Nigeria
 * (the default `min` build reports no type for NG numbers).
 */

export type PhoneNormalizationFailure = 'empty' | 'not_a_number' | 'invalid';

export type PhoneNormalization =
  | { ok: true; e164: string; country: string | null; type: string | null }
  | { ok: false; reason: PhoneNormalizationFailure };

const ALLOWED_INPUT = /^[+\d\s().-]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export function normalizeToE164(
  input: string | null | undefined,
  defaultCountry: CountryCode = 'NG',
): PhoneNormalization {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  let raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  // International dialling prefix (00…) is not understood by libphonenumber.
  if (/^00\d/.test(raw)) raw = `+${raw.slice(2)}`;
  if (!ALLOWED_INPUT.test(raw)) return { ok: false, reason: 'not_a_number' };
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed) return { ok: false, reason: 'not_a_number' };
  if (!parsed.isValid()) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    e164: parsed.number,
    country: parsed.country ?? null,
    type: parsed.getType() ?? null,
  };
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** `+2348012345678` → `2348012345678`. Throws on anything that is not E.164. */
export function toTermiiFormat(e164: string): string {
  if (!isE164(e164)) throw new Error('expected an E.164 phone number');
  return e164.slice(1);
}

/** `2348012345678` → `+2348012345678`; returns null when the value is not all digits. */
export function fromTermiiFormat(digits: string | number | null | undefined): string | null {
  if (digits === null || digits === undefined) return null;
  const text = String(digits).trim().replace(/^\+/, '');
  if (!/^[1-9]\d{6,14}$/.test(text)) return null;
  return `+${text}`;
}

export function isNigerianMobile(e164: string): boolean {
  if (!isE164(e164)) return false;
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid() || parsed.country !== 'NG') return false;
  const type = parsed.getType();
  return type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
}

/** `+2348012345678` → `+234••••••5678` for logs and admin screens. */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '•'.repeat(e164.length);
  const head = e164.slice(0, 4);
  const tail = e164.slice(-4);
  return `${head}${'•'.repeat(Math.max(2, e164.length - 8))}${tail}`;
}
