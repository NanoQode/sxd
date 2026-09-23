import { describe, expect, it } from 'vitest';
import { analyzeSegments, estimateCost, estimateMessageCost } from './segments';

describe('sms segments', () => {
  it('counts GSM-7 messages at 160 single / 153 multipart', () => {
    expect(analyzeSegments('Hello')).toMatchObject({
      encoding: 'gsm7',
      units: 5,
      segments: 1,
      remainingInSegment: 155,
    });
    expect(analyzeSegments('a'.repeat(160)).segments).toBe(1);
    expect(analyzeSegments('a'.repeat(161))).toMatchObject({ segments: 2, unitsPerSegment: 153 });
    expect(analyzeSegments('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSegments('a'.repeat(307)).segments).toBe(3);
    expect(analyzeSegments('')).toMatchObject({ segments: 0, units: 0 });
  });

  it('charges two septets for GSM extension characters', () => {
    expect(analyzeSegments('€').units).toBe(2);
    expect(analyzeSegments(`${'a'.repeat(159)}€`)).toMatchObject({
      encoding: 'gsm7',
      units: 161,
      segments: 2,
    });
  });

  it('switches to UCS-2 (70 / 67) for non-GSM characters', () => {
    expect(analyzeSegments('Olá 👋')).toMatchObject({ encoding: 'ucs2', units: 6, characters: 5 });
    expect(analyzeSegments('ń'.repeat(70)).segments).toBe(1);
    expect(analyzeSegments('ń'.repeat(71))).toMatchObject({ segments: 2, unitsPerSegment: 67 });
  });

  it('estimates cost in kobo', () => {
    expect(estimateCost({ segments: 2, unitCostKobo: 400, recipients: 3 })).toEqual({
      segments: 2,
      recipients: 3,
      unitCostKobo: 400,
      totalKobo: 2400,
    });
    expect(estimateMessageCost('a'.repeat(161), 400).totalKobo).toBe(800);
  });
});
