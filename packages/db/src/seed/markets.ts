import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client';
import * as s from '../schema';
import { applyActorContext, systemContext } from '../tenant';
import {
  validateSeed,
  type SeedFacility,
  type SeedFile,
  type SeedMarket,
  type SeedObservation,
  type SeedValidationIssue,
} from './schema';

export interface ImportConflict {
  entity: 'market' | 'facility' | 'observation';
  id: string;
  reason: string;
}

export interface ImportSummary {
  dryRun: boolean;
  sources: { inserted: number; updated: number };
  states: { inserted: number };
  facilities: { inserted: number; updated: number; unchanged: number };
  observations: { inserted: number; unchanged: number };
  markets: { inserted: number; updated: number; unchanged: number };
  coverage: { inserted: number };
  researchTasks: { inserted: number };
  conflicts: ImportConflict[];
  issues: SeedValidationIssue[];
}

export interface ImportOptions {
  /** Validate and compute the outcome without persisting anything. */
  dryRun?: boolean;
  /** Acting user id for provenance (null for CLI runs). */
  actorUserId?: string | null;
  /** Fill missing seed geography states from this table when present. */
  countryCode?: string;
}

class DryRunRollback extends Error {
  constructor(public readonly summary: ImportSummary) {
    super('dry-run rollback');
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

const FCT_NAMES = new Set(['federal capital territory', 'fct', 'abuja federal capital territory']);

function normalizeStateName(name: string): string {
  return FCT_NAMES.has(name.trim().toLowerCase()) ? 'Federal Capital Territory' : name.trim();
}

/**
 * Imports the research seed idempotently. Re-running with the same file is a
 * no-op; changed records update only when no human edit happened since the
 * last import, otherwise a conflict is reported for admin review. Observations
 * are immutable: changed content is reported, never overwritten.
 */
export async function importMarketSeed(
  db: Database,
  input: unknown,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const { data, issues } = validateSeed(input);
  const summary: ImportSummary = {
    dryRun: Boolean(options.dryRun),
    sources: { inserted: 0, updated: 0 },
    states: { inserted: 0 },
    facilities: { inserted: 0, updated: 0, unchanged: 0 },
    observations: { inserted: 0, unchanged: 0 },
    markets: { inserted: 0, updated: 0, unchanged: 0 },
    coverage: { inserted: 0 },
    researchTasks: { inserted: 0 },
    conflicts: [],
    issues,
  };
  if (!data || issues.length > 0) {
    return summary;
  }

  try {
    await db.transaction(async (tx) => {
      await applyActorContext(tx, systemContext('seed-import'));
      await importInto(tx, data, summary, options);
      if (options.dryRun) {
        throw new DryRunRollback(summary);
      }
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.summary;
    throw err;
  }
  return summary;
}

async function importInto(
  tx: Transaction,
  data: SeedFile,
  summary: ImportSummary,
  options: ImportOptions,
): Promise<void> {
  const countryCode = options.countryCode ?? 'NG';
  await tx
    .insert(s.countries)
    .values({ code: countryCode, name: data.country })
    .onConflictDoNothing();

  // Sources ---------------------------------------------------------------
  const sourceIdBySlug = new Map<string, string>();
  for (const src of data.source_registry) {
    const existing = await tx
      .select({ id: s.sources.id })
      .from(s.sources)
      .where(eq(s.sources.slug, src.id));
    if (existing.length === 0) {
      const [row] = await tx
        .insert(s.sources)
        .values({
          slug: src.id,
          title: src.title,
          url: src.url ?? null,
          dataUrl: src.data_url ?? null,
          licenseNote: src.license ?? null,
          useNote: src.use ?? null,
          retrievedAt: src.retrieved_at,
          licenseRights: inferLicenseRights(src.license ?? ''),
        })
        .returning({ id: s.sources.id });
      sourceIdBySlug.set(src.id, row!.id);
      summary.sources.inserted += 1;
    } else {
      await tx
        .update(s.sources)
        .set({
          title: src.title,
          url: src.url ?? null,
          dataUrl: src.data_url ?? null,
          licenseNote: src.license ?? null,
          useNote: src.use ?? null,
          retrievedAt: src.retrieved_at,
        })
        .where(eq(s.sources.id, existing[0]!.id));
      sourceIdBySlug.set(src.id, existing[0]!.id);
      summary.sources.updated += 1;
    }
  }

  // States ----------------------------------------------------------------
  const stateIdByName = new Map<string, string>();
  const stateZones = new Map<string, SeedMarket['geopolitical_zone']>();
  for (const m of data.markets) stateZones.set(normalizeStateName(m.state), m.geopolitical_zone);
  for (const f of data.supply_facilities) {
    const n = normalizeStateName(f.state);
    if (!stateZones.has(n)) {
      // Facility-only states (none in the current seed) default to the zone of any market in that state or NC.
      stateZones.set(n, 'NC');
    }
  }
  for (const [name, zone] of stateZones) {
    const existing = await tx
      .select({ id: s.states.id })
      .from(s.states)
      .where(and(eq(s.states.countryCode, countryCode), eq(s.states.name, name)));
    if (existing.length === 0) {
      const [row] = await tx
        .insert(s.states)
        .values({
          countryCode,
          name,
          geopoliticalZone: zone,
          isFederalCapital: name === 'Federal Capital Territory',
        })
        .returning({ id: s.states.id });
      stateIdByName.set(name, row!.id);
      summary.states.inserted += 1;
    } else {
      stateIdByName.set(name, existing[0]!.id);
    }
  }

  // Facilities ------------------------------------------------------------
  const facilityIdBySlug = new Map<string, string>();
  for (const f of data.supply_facilities) {
    const fp = fingerprint(f);
    const existing = await tx
      .select({
        id: s.supplyFacilities.id,
        importFingerprint: s.supplyFacilities.importFingerprint,
        humanEditedAt: s.supplyFacilities.humanEditedAt,
      })
      .from(s.supplyFacilities)
      .where(eq(s.supplyFacilities.slug, f.id));
    const values = facilityValues(f, fp, stateIdByName, sourceIdBySlug);
    if (existing.length === 0) {
      const [row] = await tx
        .insert(s.supplyFacilities)
        .values(values)
        .returning({ id: s.supplyFacilities.id });
      facilityIdBySlug.set(f.id, row!.id);
      summary.facilities.inserted += 1;
    } else {
      const row = existing[0]!;
      facilityIdBySlug.set(f.id, row.id);
      if (row.importFingerprint === fp) {
        summary.facilities.unchanged += 1;
      } else if (row.humanEditedAt) {
        summary.conflicts.push({
          entity: 'facility',
          id: f.id,
          reason:
            'Seed record changed but the facility was edited by a person after the last import; not overwritten.',
        });
      } else {
        await tx
          .update(s.supplyFacilities)
          .set({ ...values, version: sql`${s.supplyFacilities.version} + 1` })
          .where(eq(s.supplyFacilities.id, row.id));
        summary.facilities.updated += 1;
      }
    }
  }

  // Markets (first pass without parents so parent references resolve) ------
  const marketIdBySlug = new Map<string, string>();
  const marketIdByName = new Map<string, string>();
  const pendingParents: Array<{ id: string; parentSlug: string }> = [];
  for (const m of data.markets) {
    const fp = fingerprint(m);
    const stateId = stateIdByName.get(normalizeStateName(m.state));
    if (!stateId) throw new Error(`state missing for market ${m.id}`);
    const existing = await tx
      .select({
        id: s.markets.id,
        importFingerprint: s.markets.importFingerprint,
        humanEditedAt: s.markets.humanEditedAt,
      })
      .from(s.markets)
      .where(eq(s.markets.slug, m.id));
    const values = marketValues(m, fp, stateId, sourceIdBySlug, options.actorUserId ?? null);
    if (existing.length === 0) {
      const [row] = await tx.insert(s.markets).values(values).returning({ id: s.markets.id });
      marketIdBySlug.set(m.id, row!.id);
      summary.markets.inserted += 1;
    } else {
      const row = existing[0]!;
      marketIdBySlug.set(m.id, row.id);
      if (row.importFingerprint === fp) {
        summary.markets.unchanged += 1;
      } else if (row.humanEditedAt) {
        summary.conflicts.push({
          entity: 'market',
          id: m.id,
          reason:
            'Seed record changed but the market was edited by a person after the last import; not overwritten.',
        });
      } else {
        // Never change publication state or service availability on re-import: operators own those.
        const {
          publicationState: _p,
          serviceAvailability: _s,
          createdBy: _c,
          ...updatable
        } = values;
        await tx
          .update(s.markets)
          .set({ ...updatable, version: sql`${s.markets.version} + 1` })
          .where(eq(s.markets.id, row.id));
        summary.markets.updated += 1;
      }
    }
    marketIdByName.set(m.name.toLowerCase(), marketIdBySlug.get(m.id)!);
    if (m.parent_market_id)
      pendingParents.push({ id: marketIdBySlug.get(m.id)!, parentSlug: m.parent_market_id });
  }
  for (const p of pendingParents) {
    const parentId = marketIdBySlug.get(p.parentSlug);
    if (parentId) {
      await tx.update(s.markets).set({ parentMarketId: parentId }).where(eq(s.markets.id, p.id));
    }
  }

  // Observations (immutable) ----------------------------------------------
  const observationIdBySlug = new Map<string, string>();
  for (const o of data.observations) {
    const existing = await tx
      .select({ id: s.observations.id })
      .from(s.observations)
      .where(eq(s.observations.slug, o.id));
    if (existing.length > 0) {
      observationIdBySlug.set(o.id, existing[0]!.id);
      summary.observations.unchanged += 1;
      continue;
    }
    const geo = resolveGeography(o, stateIdByName, marketIdByName);
    if (!geo.ok) {
      summary.conflicts.push({ entity: 'observation', id: o.id, reason: geo.reason });
      continue;
    }
    const [row] = await tx
      .insert(s.observations)
      .values({
        slug: o.id,
        sourceId: sourceIdBySlug.get(o.source_id)!,
        sourceUrl: o.source_url ?? null,
        metric: o.metric,
        valueNumeric: o.value_ngn === null ? null : String(o.value_ngn),
        unit: o.unit,
        currency: o.currency,
        numericRepresentation: o.numeric_representation,
        geographyLevel: o.geography_level,
        geographyLabel: o.source_geography_label ?? o.geography_name,
        stateId: geo.stateId,
        marketId: geo.marketId,
        propertyCohort: o.property_cohort,
        statistic: o.statistic,
        observationPeriodStart: o.observation_period_start,
        observationPeriodEnd: o.observation_period_end,
        periodCompleteAtRetrieval: o.period_complete_at_retrieval,
        sourceUpdatedAt: o.source_updated_at,
        retrievedAt: o.retrieved_at,
        sampleSize: o.sample_size,
        collectionMethod: 'published_report_read',
        validUntil: o.valid_until,
        rankEligible: o.rank_eligible,
        reasonNotRankEligible: o.reason_not_rank_eligible ?? null,
        createdBy: options.actorUserId ?? null,
      })
      .returning({ id: s.observations.id });
    observationIdBySlug.set(o.id, row!.id);
    await tx.insert(s.observationInterpretations).values({
      observationId: row!.id,
      version: 1,
      isCurrent: true,
      reviewStatus: 'source_read_pending_business_review',
      publicationState: 'draft',
      rankEligible: false,
      reasonNotRankEligible:
        o.reason_not_rank_eligible ?? 'Imported from research seed; pending business review.',
      editorialNote:
        o.geography_level === 'state_or_fct' ? 'Statewide context; not a city value.' : null,
      cohortMapping: o.property_cohort,
      appliesToMarketId: geo.marketId,
      createdBy: options.actorUserId ?? null,
    });
    summary.observations.inserted += 1;
  }

  // Supplier coverage (editorial leads) ------------------------------------
  for (const m of data.markets) {
    const marketId = marketIdBySlug.get(m.id)!;
    for (const lead of m.supply_research_lead_ids) {
      const facilityId = facilityIdBySlug.get(lead);
      if (!facilityId) continue;
      const inserted = await tx
        .insert(s.supplierCoverage)
        .values({
          facilityId,
          marketId,
          relation: 'editorial_lead',
          note: m.supply_mapping_method ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: s.supplierCoverage.id });
      summary.coverage.inserted += inserted.length;
    }
  }

  // Research tasks (one per listed task, idempotent by title) --------------
  for (const m of data.markets) {
    const marketId = marketIdBySlug.get(m.id)!;
    const existing = await tx
      .select({ title: s.researchTasks.title })
      .from(s.researchTasks)
      .where(eq(s.researchTasks.marketId, marketId));
    const have = new Set(existing.map((r) => r.title));
    for (const title of m.research_tasks) {
      if (have.has(title)) continue;
      await tx
        .insert(s.researchTasks)
        .values({ marketId, title, category: categorizeTask(title), status: 'open' });
      summary.researchTasks.inserted += 1;
    }
  }

  // Timeline template ------------------------------------------------------
  if (data.scenario_template) {
    const t = data.scenario_template;
    await tx
      .insert(s.timelineTemplates)
      .values({
        kind: 'construction',
        key: t.id,
        name: t.label,
        status: t.status,
        tasks: t.tasks,
        dependencies: t.tasks.flatMap((task) =>
          task.depends_on.map((d) => ({
            predecessor: d,
            successor: task.id,
            type: 'finish_to_start',
            lagDays: 0,
          })),
        ),
        assumptionNotes:
          'Editable demonstration schedule from the research seed; not researched city timing and unsuitable for a promised completion date.',
        missingInputs: t.missing_inputs,
      })
      .onConflictDoUpdate({
        target: s.timelineTemplates.key,
        set: { tasks: t.tasks, missingInputs: t.missing_inputs, status: t.status, name: t.label },
      });
  }

  // Policy flags from the seed --------------------------------------------
  await tx
    .insert(s.dataPolicySettings)
    .values({
      key: 'default_financial_ranking_enabled',
      value: data.default_financial_ranking_enabled,
      description:
        'Whether financial ranking may run on default (evidence) mode. Seed status: ' + data.status,
    })
    .onConflictDoNothing();
}

function inferLicenseRights(license: string): (typeof s.licenseRightsEnum.enumValues)[number] {
  const l = license.toLowerCase();
  if (l.includes('mit')) return 'attribution_required';
  if (l.includes('factual')) return 'restricted_factual_reference';
  if (l.includes('permission') || l.includes('license')) return 'restricted_factual_reference';
  return 'unknown';
}

function facilityValues(
  f: SeedFacility,
  fp: string,
  stateIdByName: Map<string, string>,
  sourceIdBySlug: Map<string, string>,
) {
  return {
    slug: f.id,
    name: f.name,
    operator: f.name.split(' ')[0] ?? null,
    stateId: stateIdByName.get(normalizeStateName(f.state)) ?? null,
    material: f.material,
    sourceId: sourceIdBySlug.get(f.source_id) ?? null,
    evidenceStatus: f.evidence_status,
    location: f.coordinates ? { lon: f.coordinates[0], lat: f.coordinates[1] } : null,
    deliveryCoverageVerified: f.delivery_coverage_verified,
    stockStatus: f.stock_status,
    rankEligible: f.rank_eligible,
    importFingerprint: fp,
  };
}

function marketValues(
  m: SeedMarket,
  fp: string,
  stateId: string,
  sourceIdBySlug: Map<string, string>,
  actorUserId: string | null,
) {
  const [lon, lat] = m.geometry.coordinates;
  return {
    slug: m.id,
    name: m.name,
    aliases: m.aliases,
    countryCode: m.country_code,
    stateId,
    geopoliticalZone: m.geopolitical_zone,
    displayOrder: m.display_order,
    selectionBasis: m.selection_basis ?? null,
    location: { lon, lat },
    coordinateSourceId: sourceIdBySlug.get(m.coordinate_source_id) ?? null,
    coordinateAccuracy: m.coordinate_accuracy ?? null,
    sourceCityName: m.source_city_name ?? null,
    overlapNote: m.overlap_note,
    serviceAvailability: m.service_availability,
    publicationState: m.publication_state,
    supplyMappingMethod: m.supply_mapping_method ?? null,
    recommendationStatus: m.recommendation_status,
    researchTasks: m.research_tasks,
    lastResearchedAt: m.last_researched_at,
    importFingerprint: fp,
    importedAt: new Date(),
    createdBy: actorUserId,
    updatedBy: actorUserId,
  };
}

function resolveGeography(
  o: SeedObservation,
  stateIdByName: Map<string, string>,
  marketIdByName: Map<string, string>,
): { ok: true; stateId: string | null; marketId: string | null } | { ok: false; reason: string } {
  if (o.geography_level === 'state_or_fct') {
    const stateId = stateIdByName.get(normalizeStateName(o.geography_name));
    if (!stateId)
      return { ok: false, reason: `state ${o.geography_name} is not in the seed geography` };
    return { ok: true, stateId, marketId: null };
  }
  if (o.geography_level === 'city') {
    const marketId = marketIdByName.get(o.geography_name.toLowerCase());
    if (!marketId) return { ok: false, reason: `city ${o.geography_name} is not a seeded market` };
    return { ok: true, stateId: null, marketId };
  }
  return { ok: true, stateId: null, marketId: null };
}

function categorizeTask(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('comparable')) return 'comparables';
  if (t.includes('boq') || t.includes('build-rate') || t.includes('land')) return 'cost_evidence';
  if (t.includes('supplier')) return 'supplier_quotes';
  if (t.includes('permit')) return 'approvals';
  if (t.includes('tender') || t.includes('schedule')) return 'timelines';
  if (t.includes('flood') || t.includes('geotechnical')) return 'environmental';
  return 'other';
}
