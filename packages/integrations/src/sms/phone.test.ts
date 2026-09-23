import { describe, expect, it } from 'vitest';
import {
  fromTermiiFormat,
  isNigerianMobile,
  maskPhone,
  normalizeToE164,
  toTermiiFormat,
} from './phone';

describe('phone normalisation', () => {
  it('normalises Nigerian local, international and bare formats to E.164', () => {
    for (const input of [
      '08031234567',
      '0803 123 4567',
      '0803-123-4567',
      '(0803) 123 4567',
      '+2348031234567',
      '+234 803 123 4567',
      '2348031234567',
      '234 803 123 4567',
      '00234 803 123 4567',
    ]) {
      expect(normalizeToE164(input), input).toEqual({
        ok: true,
        e164: '+2348031234567',
        country: 'NG',
        type: 'MOBILE',
      });
    }
  });

  it('keeps foreign numbers when fully qualified', () => {
    expect(normalizeToE164('+1 415 555 2671')).toMatchObject({
      ok: true,
      e164: '+14155552671',
      country: 'US',
    });
  });

  it('rejects invalid input with a reason', () => {
    expect(normalizeToE164('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeToE164(null)).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeToE164('call me')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(normalizeToE164('12345')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeToE164('+2341234567')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeToE164('+23480312345678')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('converts to and from the Termii digits-only format', () => {
    expect(toTermiiFormat('+2348031234567')).toBe('2348031234567');
    expect(() => toTermiiFormat('2348031234567')).toThrow(/E\.164/);
    expect(fromTermiiFormat('2348031234567')).toBe('+2348031234567');
    expect(fromTermiiFormat(2348031234567)).toBe('+2348031234567');
    expect(fromTermiiFormat('abc')).toBeNull();
  });

  it('recognises Nigerian mobiles and masks numbers', () => {
    expect(isNigerianMobile('+2348031234567')).toBe(true);
    expect(isNigerianMobile('+2347012345678')).toBe(true);
    expect(isNigerianMobile('+14155552671')).toBe(false);
    expect(isNigerianMobile('2348031234567')).toBe(false);
    expect(maskPhone('+2348031234567')).toBe('+234••••••4567');
  });
});
