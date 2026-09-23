import { z } from 'zod';

/** Zod contract for data/seed/nigeria-50-markets.seed.json (schema_version 1.0.0). */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const seedSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  data_url: z.string().url().optional().nullable(),
  license: z.string().optional().nullable(),
  use: z.string().optional().nullable(),
  retrieved_at: isoDate,
});

export const seedObservationSchema = z.object({
  id: z.string().min(1),
  geography_level: z.enum(['country', 'state_or_fct', 'city', 'neighborhood', 'site']),
  geography_name: z.string().min(1),
  metric: z.string().min(1),
  value_ngn: z.number().finite().nullable(),
  sample_size: z.number().int().nonnegative().nullable(),
  source_id: z.string().min(1),
  source_url: z.string().url().optional().nullable(),
  source_geography_label: z.string().optional().nullable(),
  currency: z.string().default('NGN'),
  numeric_representation: z.enum([
    'whole_naira_not_kobo',
    'kobo',
    'percent',
    'days',
    'count',
    'text',
    'other',
  ]),
  unit: z.string().min(1),
  property_cohort: z.string().min(1),
  statistic: z.enum([
    'median',
    'mean',
    'min',
    'max',
    'range',
    'count',
    'categorical',
    'quote',
    'single_observation',
  ]),
  observation_period_start: isoDate.nullable(),
  observation_period_end: isoDate.nullable(),
  period_complete_at_retrieval: z.boolean().nullable(),
  source_updated_at: isoDate.nullable(),
  retrieved_at: isoDate,
  valid_until: isoDate.nullable(),
  review_status: z.string().min(1),
  rank_eligible: z.boolean(),
  reason_not_rank_eligible: z.string().nullable().optional(),
});

export const seedFacilitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.string().min(1),
  material: z.enum([
    'cement',
    'ready_mix',
    'steel',
    'sand',
    'aggregate',
    'blocks',
    'timber',
    'roofing',
    'electrical',
    'plumbing',
    'other',
  ]),
  source_id: z.string().min(1),
  evidence_status: z.enum(['published_facility_location', 'unverified_lead', 'verified_supplier']),
  coordinates: z.tuple([z.number(), z.number()]).nullable(),
  delivery_coverage_verified: z.boolean(),
  delivered_quote_ngn: z.number().nullable(),
  lead_time_days: z.number().nullable(),
  stock_status: z.enum(['unknown', 'in_stock', 'limited', 'out_of_stock']),
  rank_eligible: z.boolean(),
});

export const seedMarketMetricsSchema = z.object({
  land_price_ngn_per_m2: z.number().nullable(),
  build_rate_ngn_per_m2: z.number().nullable(),
  annual_rent_by_property_cohort: z.unknown().nullable(),
  material_delivery_cost_ngn: z.number().nullable(),
  material_delivery_days: z.number().nullable(),
  contractor_bid_window_days: z.number().nullable(),
  construction_duration_days: z.number().nullable(),
  approval_duration_days: z.number().nullable(),
  projected_net_yield_percent: z.number().nullable(),
  flood_risk: z.string().nullable(),
  soil_suitability: z.string().nullable(),
  power_reliability: z.string().nullable(),
  water_reliability: z.string().nullable(),
  demand_index: z.number().nullable(),
});

export const seedMarketSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'market id must be a slug'),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  country_code: z.literal('NG'),
  state: z.string().min(1),
  geopolitical_zone: z.enum(['NC', 'NE', 'NW', 'SE', 'SS', 'SW']),
  display_order: z.number().int(),
  selection_basis: z.string().optional().nullable(),
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().finite(), z.number().finite()]),
  }),
  coordinate_source_id: z.string().min(1),
  coordinate_accuracy: z.string().optional().nullable(),
  source_city_name: z.string().optional().nullable(),
  parent_market_id: z.string().nullable(),
  overlap_note: z.string().nullable(),
  service_availability: z.enum([
    'pending_operations_confirmation',
    'available',
    'limited',
    'on_request',
    'unavailable',
  ]),
  publication_state: z.enum(['draft', 'in_review', 'published', 'unpublished', 'archived']),
  local_observation_ids: z.array(z.string()).default([]),
  regional_context_observation_ids: z.array(z.string()).default([]),
  supply_research_lead_ids: z.array(z.string()).default([]),
  supply_mapping_method: z.string().optional().nullable(),
  metrics: seedMarketMetricsSchema,
  recommendation_status: z.enum([
    'insufficient_local_evidence',
    'assumption_mode_only',
    'eligible',
    'gated_by_policy',
  ]),
  research_tasks: z.array(z.string()).default([]),
  last_researched_at: isoDate.nullable(),
});

export const seedTemplateTaskSchema = z.object({
  id: z.string().min(1),
  duration_working_days: z.number().int().nonnegative().nullable(),
  depends_on: z.array(z.string()),
});

export const seedScenarioTemplateSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  status: z.string(),
  tasks: z.array(seedTemplateTaskSchema),
  can_compute_completion_date: z.boolean(),
  missing_inputs: z.array(z.string()),
  financial_defaults: z.unknown().nullable(),
});

export const seedFileSchema = z.object({
  schema_version: z.literal('1.0.0'),
  prepared_at: isoDate,
  country: z.string(),
  selection_method: z.string(),
  coordinate_system: z.string(),
  status: z.string(),
  default_financial_ranking_enabled: z.boolean(),
  source_registry: z.array(seedSourceSchema),
  observations: z.array(seedObservationSchema),
  supply_facilities: z.array(seedFacilitySchema),
  markets: z.array(seedMarketSchema),
  scenario_template: seedScenarioTemplateSchema.optional().nullable(),
});

export type SeedFile = z.infer<typeof seedFileSchema>;
export type SeedMarket = z.infer<typeof seedMarketSchema>;
export type SeedObservation = z.infer<typeof seedObservationSchema>;
export type SeedFacility = z.infer<typeof seedFacilitySchema>;

/** Nigeria bounding box used for coordinate sanity checks (lon, lat). */
export const NIGERIA_BBOX = { minLon: 2.5, maxLon: 15, minLat: 4, maxLat: 14 } as const;

export interface SeedValidationIssue {
  path: string;
  message: string;
}

/**
 * Structural and referential validation per the import contract in
 * data/seed/DATA-RESEARCH-NOTES.md. Returns issues rather than throwing so the
 * admin preview can show row-level errors.
 */
export function validateSeed(input: unknown): {
  data: SeedFile | null;
  issues: SeedValidationIssue[];
} {
  const parsed = seedFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      data: null,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const data = parsed.data;
  const issues: SeedValidationIssue[] = [];
  const sourceIds = new Set(data.source_registry.map((s) => s.id));
  const obsIds = new Set<string>();
  const facilityIds = new Set<string>();
  const marketIds = new Set<string>();

  for (const [i, o] of data.observations.entries()) {
    if (obsIds.has(o.id))
      issues.push({ path: `observations.${i}.id`, message: `duplicate observation id ${o.id}` });
    obsIds.add(o.id);
    if (!sourceIds.has(o.source_id))
      issues.push({
        path: `observations.${i}.source_id`,
        message: `unknown source ${o.source_id}`,
      });
  }
  for (const [i, f] of data.supply_facilities.entries()) {
    if (facilityIds.has(f.id))
      issues.push({ path: `supply_facilities.${i}.id`, message: `duplicate facility id ${f.id}` });
    facilityIds.add(f.id);
    if (!sourceIds.has(f.source_id))
      issues.push({
        path: `supply_facilities.${i}.source_id`,
        message: `unknown source ${f.source_id}`,
      });
  }
  for (const [i, m] of data.markets.entries()) {
    if (marketIds.has(m.id))
      issues.push({ path: `markets.${i}.id`, message: `duplicate market id ${m.id}` });
    marketIds.add(m.id);
  }
  for (const [i, m] of data.markets.entries()) {
    const [lon, lat] = m.geometry.coordinates;
    if (
      lon < NIGERIA_BBOX.minLon ||
      lon > NIGERIA_BBOX.maxLon ||
      lat < NIGERIA_BBOX.minLat ||
      lat > NIGERIA_BBOX.maxLat
    ) {
      issues.push({
        path: `markets.${i}.geometry`,
        message: `coordinates [${lon}, ${lat}] fall outside Nigeria (longitude, latitude order expected)`,
      });
    }
    if (!sourceIds.has(m.coordinate_source_id))
      issues.push({
        path: `markets.${i}.coordinate_source_id`,
        message: `unknown source ${m.coordinate_source_id}`,
      });
    if (m.parent_market_id && !marketIds.has(m.parent_market_id))
      issues.push({
        path: `markets.${i}.parent_market_id`,
        message: `unknown parent market ${m.parent_market_id}`,
      });
    for (const id of [...m.local_observation_ids, ...m.regional_context_observation_ids]) {
      if (!obsIds.has(id))
        issues.push({ path: `markets.${i}`, message: `unknown observation ${id}` });
    }
    for (const id of m.supply_research_lead_ids) {
      if (!facilityIds.has(id))
        issues.push({
          path: `markets.${i}.supply_research_lead_ids`,
          message: `unknown facility ${id}`,
        });
    }
  }
  return { data: issues.length === 0 ? data : data, issues };
}
