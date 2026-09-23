import { METRIC_KEYS, type MetricKey } from '@simplexd/domain/ranking';

/**
 * Metric-name mapping between stored observations and the ranking policy's
 * seven metrics. An observation feeds a ranking metric only when its metric
 * name is listed here and its unit matches the policy unit; anything else
 * stays in the evidence panels and never becomes a score.
 *
 * | Ranking metric                  | Policy unit | Observation metrics accepted                                    |
 * | ------------------------------- | ----------- | --------------------------------------------------------------- |
 * | affordability                   | NGN/m2      | total_development_cost_ngn_per_m2, or land_price_ngn_per_m2 AND  |
 * |                                 |             | build_rate_ngn_per_m2 combined with the user's land/floor areas  |
 * | material_access                 | days        | material_delivery_days, material_lead_time_days                 |
 * | net_rental_economics            | percent     | projected_net_yield_percent, net_yield_percent                  |
 * | construction_duration           | days        | construction_duration_days                                      |
 * | approval_duration               | days        | approval_duration_days, observed_permit_duration_days           |
 * | evidence_backed_demand          | index       | demand_index                                                    |
 * | infrastructure_site_suitability | index       | site_suitability_index, infrastructure_site_suitability_index   |
 *
 * The seed's `median_annual_asking_rent` and `median_asking_sale_price` rows
 * are mixed-stock medians: they are deliberately absent from this table, so
 * they are shown as context and are never divided into a yield claim.
 */
export const OBSERVATION_METRICS_BY_RANKING_METRIC: Record<MetricKey, readonly string[]> = {
  affordability: ['total_development_cost_ngn_per_m2'],
  material_access: ['material_delivery_days', 'material_lead_time_days'],
  net_rental_economics: ['projected_net_yield_percent', 'net_yield_percent'],
  construction_duration: ['construction_duration_days'],
  approval_duration: ['approval_duration_days', 'observed_permit_duration_days'],
  evidence_backed_demand: ['demand_index'],
  infrastructure_site_suitability: [
    'site_suitability_index',
    'infrastructure_site_suitability_index',
  ],
};

/** Canonical units the policy bounds are expressed in (must match `rankingPolicyV1`). */
export const RANKING_METRIC_UNITS: Record<MetricKey, string> = {
  affordability: 'NGN/m2',
  material_access: 'days',
  net_rental_economics: 'percent',
  construction_duration: 'days',
  approval_duration: 'days',
  evidence_backed_demand: 'index',
  infrastructure_site_suitability: 'index',
};

/** Cost components combined into affordability when the user's areas are known. */
export const LAND_PRICE_METRIC = 'land_price_ngn_per_m2';
export const BUILD_RATE_METRIC = 'build_rate_ngn_per_m2';
export const COST_PER_M2_UNIT = 'NGN/m2';

/** Locally applicable cost evidence for the ranking gate. */
export const COST_EVIDENCE_METRICS: ReadonlySet<string> = new Set([
  LAND_PRICE_METRIC,
  BUILD_RATE_METRIC,
  'total_development_cost_ngn_per_m2',
]);

/** Locally applicable rental evidence for the ranking gate (matched-cohort rents and yields). */
export const RENT_EVIDENCE_METRICS: ReadonlySet<string> = new Set([
  'annual_rent_per_unit_ngn',
  'median_annual_rent_ngn',
  'median_annual_asking_rent',
  'projected_net_yield_percent',
  'net_yield_percent',
]);

const RANKING_METRIC_BY_OBSERVATION: ReadonlyMap<string, MetricKey> = new Map(
  METRIC_KEYS.flatMap((key) =>
    OBSERVATION_METRICS_BY_RANKING_METRIC[key].map((name): [string, MetricKey] => [name, key]),
  ),
);

/** The ranking metric an observation metric feeds directly, if any. */
export function rankingMetricFor(observationMetric: string): MetricKey | null {
  return RANKING_METRIC_BY_OBSERVATION.get(observationMetric.toLowerCase()) ?? null;
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  affordability: 'Affordability (development cost per m²)',
  material_access: 'Material delivery and access',
  net_rental_economics: 'Net rental economics',
  construction_duration: 'Construction duration',
  approval_duration: 'Approval duration',
  evidence_backed_demand: 'Evidence-backed demand',
  infrastructure_site_suitability: 'Infrastructure and site suitability',
};

/** What is missing, in words, for each ranking gate item. */
export const MISSING_LABELS: Record<
  MetricKey | 'local_cost_evidence' | 'local_rent_evidence',
  string
> = {
  ...METRIC_LABELS,
  local_cost_evidence:
    'Locally applicable cost evidence (current land price and build-rate or BOQ evidence for this market)',
  local_rent_evidence:
    'Locally applicable rental evidence (matched-cohort rents or observed yields for this market)',
};
