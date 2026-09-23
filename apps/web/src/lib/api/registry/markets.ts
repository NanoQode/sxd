import { z } from 'zod';
import {
  calculatorRunRequestSchema,
  calculatorRunResponseSchema,
  comparisonReportSchema,
  comparisonRequestSchema,
  comparisonResponseSchema,
  listRoutes,
  marketDetailSchema,
  marketGeoJsonSchema,
  marketListQuerySchema,
  marketListResponseSchema,
  marketObservationsPageSchema,
  marketObservationsQuerySchema,
  recommendationRequestSchema,
  recommendationResponseSchema,
  registerRoute,
  scenarioCreateSchema,
  scenarioDtoSchema,
  scenarioListQuerySchema,
  scenarioPageSchema,
  scenarioShareRequestSchema,
  scenarioShareResponseSchema,
  scenarioSnapshotResponseSchema,
  scenarioUpdateSchema,
  scenarioVerificationRequestSchema,
  scenarioVerificationResponseSchema,
  sharedScenarioResponseSchema,
  stateListResponseSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for the market read model, recommendations,
 * comparisons, calculators and saved scenarios. Route handlers import this
 * module for its side effect; registration is idempotent so hot reloads and
 * shared bundles never trip the duplicate-operation guard.
 */

const idParams = z.object({ id: uuidSchema });
const slugParams = z.object({ slug: z.string().min(1).max(120) });
const idOrSlugParams = z.object({ idOrSlug: z.string().min(1).max(120) });
const tokenParams = z.object({ token: z.string().min(16).max(128) });

function register(spec: RouteSpec): void {
  if (listRoutes().some((r) => r.operationId === spec.operationId)) return;
  registerRoute(spec);
}

const specs: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/v1/markets',
    summary: 'List markets for the explorer',
    description:
      'Published markets with evidence summaries and rank-eligible local metrics (null when unknown). ' +
      'bbox is minLon,minLat,maxLon,maxLat (WGS84). Staff with market_data.read_drafts may pass ' +
      'includeUnpublished. objective is accepted for deep links and does not restrict the list.',
    tags: ['markets'],
    operationId: 'listMarkets',
    auth: 'public',
    request: { query: marketListQuerySchema },
    responses: { 200: { description: 'Market list', body: marketListResponseSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/markets/geojson',
    summary: 'Published markets as a GeoJSON FeatureCollection',
    description: 'Longitude/latitude points for the map layer; cached for 60 seconds.',
    tags: ['markets'],
    operationId: 'marketsGeoJson',
    auth: 'public',
    responses: { 200: { description: 'FeatureCollection', body: marketGeoJsonSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/markets/{slug}',
    summary: 'Market detail with evidence panels',
    description:
      'Local observations, statewide context (never presented as city values), supplier leads, quotes, ' +
      'flags, research tasks and missing evidence. Unpublished markets are 404 unless the caller may read drafts.',
    tags: ['markets'],
    operationId: 'getMarket',
    auth: 'public',
    request: { params: slugParams },
    responses: {
      200: { description: 'Market detail', body: marketDetailSchema },
      404: { description: 'Unknown or unpublished market' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/markets/{idOrSlug}/observations',
    summary: 'Cursor-paginated observations for a market',
    description:
      'Local rows first, then statewide/national context, each carrying its badge and freshness.',
    tags: ['markets'],
    operationId: 'listMarketObservations',
    auth: 'public',
    request: { params: idOrSlugParams, query: marketObservationsQuerySchema },
    responses: {
      200: { description: 'Observation page', body: marketObservationsPageSchema },
      404: { description: 'Unknown or unpublished market' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/states',
    summary: 'States with visible market counts',
    tags: ['markets'],
    operationId: 'listStates',
    auth: 'public',
    responses: { 200: { description: 'State list', body: stateListResponseSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/recommendations',
    summary: 'Rank or screen markets under the active policy',
    description:
      'Evidence mode uses rank-eligible local observations only; assumption mode is a visibly separate ' +
      'scenario comparison driven by the supplied assumptions. Nothing is persisted.',
    tags: ['recommendations'],
    operationId: 'runRecommendation',
    auth: 'public',
    request: { body: recommendationRequestSchema },
    responses: { 200: { description: 'Recommendation', body: recommendationResponseSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/comparisons',
    summary: 'Compare two to four markets side by side',
    description:
      'Units, evidence dates, confidence and scope per cell; statewide context is labelled; overlapping markets are flagged.',
    tags: ['recommendations'],
    operationId: 'runComparison',
    auth: 'public',
    request: { body: comparisonRequestSchema },
    responses: { 200: { description: 'Comparison', body: comparisonResponseSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/calculators/run',
    summary: 'Run the feasibility calculators without persistence',
    description:
      'Development cost, long-let or short-stay economics, phasing, NPV/IRR, sensitivity and low/base/high sets; absent inputs are reported, never defaulted.',
    tags: ['calculators'],
    operationId: 'runCalculators',
    auth: 'public',
    request: { body: calculatorRunRequestSchema },
    responses: { 200: { description: 'Calculator results', body: calculatorRunResponseSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/scenarios',
    summary: 'List my saved scenarios',
    tags: ['scenarios'],
    operationId: 'listScenarios',
    auth: 'public',
    request: { query: scenarioListQuerySchema },
    responses: { 200: { description: 'Scenario page', body: scenarioPageSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/scenarios',
    summary: 'Save a scenario',
    description:
      'Anonymous visitors may save up to 20 scenarios when core.anonymous_scenarios is enabled.',
    tags: ['scenarios'],
    operationId: 'createScenario',
    auth: 'public',
    request: { body: scenarioCreateSchema },
    responses: { 201: { description: 'Created scenario', body: scenarioDtoSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/scenarios/{id}',
    summary: 'Read a scenario',
    tags: ['scenarios'],
    operationId: 'getScenario',
    auth: 'public',
    request: { params: idParams },
    responses: { 200: { description: 'Scenario', body: scenarioDtoSchema } },
  },
  {
    method: 'patch',
    path: '/api/v1/scenarios/{id}',
    summary: 'Update a scenario (optimistic concurrency via expectedUpdatedAt)',
    tags: ['scenarios'],
    operationId: 'updateScenario',
    auth: 'public',
    request: { params: idParams, body: scenarioUpdateSchema },
    responses: {
      200: { description: 'Updated scenario', body: scenarioDtoSchema },
      409: { description: 'version_conflict when expectedUpdatedAt is stale' },
    },
  },
  {
    method: 'delete',
    path: '/api/v1/scenarios/{id}',
    summary: 'Delete a scenario (soft delete; snapshots are retained)',
    tags: ['scenarios'],
    operationId: 'deleteScenario',
    auth: 'public',
    request: { params: idParams },
    responses: { 204: { description: 'Deleted' } },
  },
  {
    method: 'post',
    path: '/api/v1/scenarios/{id}/claim',
    summary: 'Attach an anonymous scenario to the signed-in account',
    tags: ['scenarios'],
    operationId: 'claimScenario',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'Claimed scenario', body: scenarioDtoSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/scenarios/{id}/share',
    summary: 'Create a private, expiring share link',
    tags: ['scenarios'],
    operationId: 'shareScenario',
    auth: 'session',
    request: { params: idParams, body: scenarioShareRequestSchema },
    responses: { 200: { description: 'Share token', body: scenarioShareResponseSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/scenarios/shared/{token}',
    summary: 'Read a shared scenario (read-only)',
    tags: ['scenarios'],
    operationId: 'getSharedScenario',
    auth: 'public',
    request: { params: tokenParams },
    responses: { 200: { description: 'Shared scenario', body: sharedScenarioResponseSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/scenarios/{id}/snapshot',
    summary: 'Run and store the scenario recommendation',
    description:
      'Stores policy version, exact inputs, source versions and results; never recomputed later.',
    tags: ['scenarios'],
    operationId: 'snapshotScenario',
    auth: 'public',
    request: { params: idParams },
    responses: { 201: { description: 'Snapshot', body: scenarioSnapshotResponseSchema } },
  },
  {
    method: 'get',
    path: '/api/v1/scenarios/{id}/report',
    summary: 'Dated comparison report from the latest snapshot',
    tags: ['scenarios'],
    operationId: 'scenarioReport',
    auth: 'public',
    request: { params: idParams },
    responses: { 200: { description: 'Comparison report', body: comparisonReportSchema } },
  },
  {
    method: 'post',
    path: '/api/v1/scenarios/{id}/request-verification',
    summary: 'Request local verification of a scenario (creates a lead)',
    tags: ['scenarios'],
    operationId: 'requestScenarioVerification',
    auth: 'public',
    request: { params: idParams, body: scenarioVerificationRequestSchema },
    responses: { 201: { description: 'Lead created', body: scenarioVerificationResponseSchema } },
  },
];

for (const spec of specs) register(spec);

export const marketRouteSpecs: readonly RouteSpec[] = specs;
