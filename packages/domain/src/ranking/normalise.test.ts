import { describe, expect, it } from 'vitest';
import { boundProblems, clamp01, isValidBound, normaliseScore, unitsMatch } from './normalise';
import type { MetricBound } from './types';

const higher: MetricBound = {
  metric: 'net_rental_economics',
  direction: 'higher_is_better',
  unit: 'percent',
  low: 0,
  high: 12,
};

const lower: MetricBound = {
  metric: 'construction_duration',
  direction: 'lower_is_better',
  unit: 'days',
  low: 120,
  high: 720,
};

describe('normaliseScore', () => {
  it('scores higher-is-better metrics upward: s = (x - low) / (high - low)', () => {
    expect(normaliseScore(9, higher)).toBeCloseTo(0.75, 12);
    expect(normaliseScore(0, higher)).toBe(0);
    expect(normaliseScore(12, higher)).toBe(1);
  });

  it('reverses lower-is-better metrics so lower costs and shorter durations score higher', () => {
    expect(normaliseScore(300, lower)).toBeCloseTo(0.7, 12);
    expect(normaliseScore(120, lower)).toBe(1);
    expect(normaliseScore(720, lower)).toBe(0);
  });

  it('clamps values outside the anchors to 0 and 1', () => {
    expect(normaliseScore(2000, lower)).toBe(0);
    expect(normaliseScore(1, lower)).toBe(1);
    expect(normaliseScore(-5, higher)).toBe(0);
    expect(normaliseScore(150, higher)).toBe(1);
  });

  it('returns null, never 0 or 1, for non-finite values and invalid bounds', () => {
    expect(normaliseScore(Number.NaN, higher)).toBeNull();
    expect(normaliseScore(Number.POSITIVE_INFINITY, higher)).toBeNull();
    expect(normaliseScore(5, { ...higher, high: 0 })).toBeNull();
    expect(normaliseScore(5, { ...higher, low: Number.NaN })).toBeNull();
  });
});

describe('boundProblems', () => {
  it('accepts a valid bound', () => {
    expect(boundProblems(higher)).toEqual([]);
    expect(isValidBound(lower)).toBe(true);
  });

  it('rejects equal, inverted and non-finite bounds', () => {
    expect(boundProblems({ ...higher, high: 0 })).toEqual(['high (0) must exceed low (0)']);
    expect(boundProblems({ ...lower, low: 720, high: 120 })).toHaveLength(1);
    expect(boundProblems({ ...higher, high: Number.POSITIVE_INFINITY })).toEqual([
      'high must be a finite number, got Infinity',
    ]);
    expect(isValidBound({ ...higher, unit: ' ' })).toBe(false);
  });
});

describe('clamp01 and unitsMatch', () => {
  it('lets NaN through instead of hiding it as 0', () => {
    expect(Number.isNaN(clamp01(Number.NaN))).toBe(true);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it('compares units after trimming and lower-casing only', () => {
    expect(unitsMatch('NGN/m2', ' ngn/M2 ')).toBe(true);
    expect(unitsMatch('NGN/m2', 'NGN/sqft')).toBe(false);
    expect(unitsMatch('NGN', 'kobo')).toBe(false);
  });
});
