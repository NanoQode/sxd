/**
 * Recommendation snapshots.
 *
 * Brief (quoted): "Store policy version, inputs and source versions with every saved
 * recommendation." and "old saved reports retain their snapshots."
 */

import { hashValue } from './hash';
import { METRIC_KEYS } from './types';
import type { MarketInput, RankingResult, RecommendationSnapshot, SnapshotSource } from './types';

/** Source versions declared on the inputs, keyed `<marketId>:<metric>` (and `<marketId>:total_cost`). */
export function collectSourceVersions(inputs: readonly MarketInput[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const market of inputs) {
    for (const metric of METRIC_KEYS) {
      const version = market.metrics?.[metric]?.sourceVersion;
      if (version !== undefined) versions[`${market.id}:${metric}`] = version;
    }
    const totalCostVersion = market.totalCostEvidence?.sourceVersion;
    if (totalCostVersion !== undefined) versions[`${market.id}:total_cost`] = totalCostVersion;
  }
  return sortRecord(versions);
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/**
 * Packages a ranking result with the policy version, a stable hash of the inputs (and of the policy
 * itself) and the source versions, so that a saved recommendation can always be traced to what
 * produced it. Throws when the result was not produced by the given policy version.
 */
export function buildSnapshot(
  result: RankingResult,
  source: SnapshotSource,
): RecommendationSnapshot {
  if (source.policy.version !== result.policyVersion) {
    throw new RangeError(
      `result was produced by policy version ${result.policyVersion}, not ${source.policy.version}`,
    );
  }
  return {
    policyVersion: source.policy.version,
    generatedFrom: {
      inputsHash: hashValue(source.inputs),
      policyHash: hashValue(source.policy),
      sourceVersions: sortRecord(source.sourceVersions ?? collectSourceVersions(source.inputs)),
    },
    results: result,
  };
}
