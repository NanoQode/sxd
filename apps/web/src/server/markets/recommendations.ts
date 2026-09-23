import 'server-only';
import { inArray } from 'drizzle-orm';
import {
  ApiError,
  type RecommendationRequest,
  type RecommendationResponse,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import {
  buildSnapshot,
  collectSourceVersions,
  type MarketInput,
  type RankingResult,
  type RecommendationSnapshot,
} from '@simplexd/domain/ranking';
import type { RequestIdentity } from '@/lib/auth/session';
import { visibilityFor, type Visibility } from './access';
import { loadBundles, loadMarketRows, marketPublicationFilter } from './load';
import { loadPolicyContext, type PolicyContext } from './policy';
import { runRankingAdapter, type RankingRequest } from './ranking-adapter';
import type { MarketBundle } from './types';

/**
 * Recommendation orchestration: loads the active policy and the visible
 * markets with their evidence, runs the ranking adapter and packages the
 * result with the snapshot material (policy version, exact inputs, source
 * versions) that a saved scenario stores.
 */

export interface RecommendationRun {
  response: RecommendationResponse;
  result: RankingResult;
  marketInputs: MarketInput[];
  snapshot: RecommendationSnapshot;
  policy: PolicyContext;
  bundles: MarketBundle[];
}

export function toRankingRequest(request: RecommendationRequest): RankingRequest {
  return {
    objective: request.objective,
    mode: request.mode,
    filters: request.filters,
    priorities: request.priorities,
    assumptions: request.assumptions,
    rank: request.rank,
    budgetCeiling: request.budgetCeiling,
  };
}

/** Published markets only: drafts are never ranked, whoever asks. */
const PUBLISHED: Visibility = { readDrafts: false, includeUnpublished: false };

export async function loadRankableBundles(
  tx: DbExecutor,
  marketIds: readonly string[] | undefined,
  visibility: Visibility,
): Promise<MarketBundle[]> {
  const where = [marketPublicationFilter(PUBLISHED)];
  if (marketIds !== undefined) {
    if (marketIds.length === 0) return [];
    where.push(inArray(schema.markets.id, [...marketIds]));
  }
  const rows = await loadMarketRows(tx, where);
  if (marketIds !== undefined && rows.length !== new Set(marketIds).size) {
    const found = new Set(rows.map((r) => r.market.id));
    const missing = marketIds.filter((id) => !found.has(id));
    throw new ApiError('not_found', 'some markets are unknown or not published', {
      details: { marketIds: missing },
    });
  }
  return loadBundles(tx, rows, visibility);
}

/** Source versions: every observation interpretation the inputs used, plus the policy itself. */
export function sourceVersionsFor(marketInputs: readonly MarketInput[], policy: PolicyContext) {
  return {
    ...collectSourceVersions(marketInputs),
    ranking_policy: `v${policy.policy.version}:${policy.policyRowId}`,
  };
}

/** Runs a recommendation inside an existing transaction (used by scenario snapshots). */
export async function runRecommendationIn(
  tx: DbExecutor,
  request: RecommendationRequest,
  identity: RequestIdentity,
  asOf: Date,
): Promise<RecommendationRun> {
  const visibility = visibilityFor(identity);
  const policy = await loadPolicyContext(tx, asOf);
  const bundles = await loadRankableBundles(tx, request.marketIds, visibility);
  const adapter = runRankingAdapter({ bundles, policy, request: toRankingRequest(request), asOf });
  const snapshot = buildSnapshot(adapter.result, {
    policy: policy.policy,
    inputs: adapter.marketInputs,
    sourceVersions: sourceVersionsFor(adapter.marketInputs, policy),
  });
  return {
    response: adapter.response,
    result: adapter.result,
    marketInputs: adapter.marketInputs,
    snapshot,
    policy,
    bundles,
  };
}

/** POST /api/v1/recommendations: nothing is persisted; saved scenarios use the snapshot endpoint. */
export async function runRecommendation(
  request: RecommendationRequest,
  identity: RequestIdentity,
): Promise<RecommendationRun> {
  const asOf = new Date();
  return withActor(getDb(), identity.ctx, (tx) => runRecommendationIn(tx, request, identity, asOf));
}
