import { describe, expect, it } from 'vitest';
import { fnv1a32, hashValue, stableStringify } from './hash';
import { DEFAULT_RANKING_POLICY } from './policy';
import { rankMarkets } from './rank';
import { buildSnapshot, collectSourceVersions } from './snapshot';
import { baseOptions, fullMarket, fullMetrics, input } from './test-fixtures';
import type { MarketInput } from './types';

describe('stable hashing', () => {
  it('matches the FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('serialises with sorted keys so insertion order never changes the digest', () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }], u: undefined })).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}',
    );
    expect(hashValue({ x: 1, y: 2 })).toBe(hashValue({ y: 2, x: 1 }));
    expect(hashValue({ x: 1, y: 2 })).not.toBe(hashValue({ x: 1, y: 3 }));
  });
});

describe('buildSnapshot', () => {
  const inputs: MarketInput[] = [
    fullMarket('a', {
      metrics: fullMetrics({
        affordability: input('affordability', 500_000, { sourceVersion: 'src-a@3' }),
      }),
    }),
    fullMarket('b'),
  ];
  const result = rankMarkets(inputs, DEFAULT_RANKING_POLICY, baseOptions);

  it('stores the policy version, a stable inputs hash and the source versions with the results', () => {
    const snapshot = buildSnapshot(result, { policy: DEFAULT_RANKING_POLICY, inputs });
    expect(snapshot.policyVersion).toBe(1);
    expect(snapshot.generatedFrom.inputsHash).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(snapshot.generatedFrom.policyHash).toBe(hashValue(DEFAULT_RANKING_POLICY));
    expect(snapshot.generatedFrom.sourceVersions).toEqual({ 'a:affordability': 'src-a@3' });
    expect(snapshot.results).toBe(result);
  });

  it('hashes inputs independently of key order and differently for different inputs', () => {
    const reordered = inputs.map((m) => ({
      hasLocalRentEvidence: m.hasLocalRentEvidence,
      name: m.name,
      metrics: m.metrics,
      flags: m.flags,
      id: m.id,
      hasLocalCostEvidence: m.hasLocalCostEvidence,
    })) as MarketInput[];
    const first = buildSnapshot(result, { policy: DEFAULT_RANKING_POLICY, inputs });
    const second = buildSnapshot(result, { policy: DEFAULT_RANKING_POLICY, inputs: reordered });
    expect(second.generatedFrom.inputsHash).toBe(first.generatedFrom.inputsHash);
    const changed = buildSnapshot(result, {
      policy: DEFAULT_RANKING_POLICY,
      inputs: [fullMarket('a'), fullMarket('b')],
    });
    expect(changed.generatedFrom.inputsHash).not.toBe(first.generatedFrom.inputsHash);
  });

  it('uses explicit source versions when given, sorted', () => {
    const snapshot = buildSnapshot(result, {
      policy: DEFAULT_RANKING_POLICY,
      inputs,
      sourceVersions: { z: '2', a: '1' },
    });
    expect(Object.keys(snapshot.generatedFrom.sourceVersions)).toEqual(['a', 'z']);
    expect(collectSourceVersions(inputs)).toEqual({ 'a:affordability': 'src-a@3' });
  });

  it('refuses to pair a result with a different policy version', () => {
    expect(() =>
      buildSnapshot(result, { policy: { ...DEFAULT_RANKING_POLICY, version: 2 }, inputs }),
    ).toThrow(RangeError);
  });
});
