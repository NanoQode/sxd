import { and, eq, inArray, like, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  enqueueJob,
  schema,
  systemContext,
  withActor,
  type Database,
  type Transaction,
} from '@simplexd/db';
import { freshnessDataTypeFor, isFresh } from '@simplexd/domain/evidence';

/**
 * Stale-evidence sweep (brief §8/§19 "overdue reviews"): applies the editable
 * freshness policies (`freshness_policies`, Admin → Market data → Freshness)
 * to every current, published observation interpretation and opens a research
 * task for data editors when one has gone stale.
 *
 * - Published data is never changed. The public read model already derives a
 *   "stale" badge at read time; an editor decides whether to publish a newer
 *   observation or mark the interpretation stale.
 * - Idempotent per observation per staleness period: the sweep enqueues
 *   `market_data.open_refresh_task` with the dedupe key
 *   `market_data.refresh:<observationId>:<staleSince>`, so repeated sweeps
 *   never queue a second task for the same period. A new period starts when
 *   the date the evidence went stale changes (e.g. an editor extended the
 *   validity with a freshness override and it lapsed again).
 * - The task job re-checks the observation before creating anything and skips
 *   when a task opened by an earlier sweep for the same observation is still
 *   not done.
 *
 * Mirrors `observationFreshness` in apps/web/src/server/markets/evidence.ts:
 * observation date = period end, else the source's update date (never the
 * retrieval date); an editorial freshness override wins over the source's
 * valid-until. Metrics without a configured freshness policy are not swept.
 */

export const REFRESH_TASK_JOB = 'market_data.open_refresh_task';
export const REFRESH_TASK_CATEGORY = 'evidence_refresh';
const DAY_MS = 86_400_000;
/** Review statuses an editor has already acted on; the sweep leaves them alone. */
const SETTLED_REVIEW_STATUSES = ['stale', 'rejected', 'superseded'] as const;

export interface FreshnessWindow {
  maxAgeDays: number | null;
  respectSourceValidity: boolean;
}

export interface EvidenceDates {
  metric: string;
  observationPeriodEnd: string | null;
  sourceUpdatedAt: string | null;
  validUntil: string | null;
  freshnessOverrideUntil: string | null;
}

export type StalenessVerdict =
  | { stale: false; reason: 'fresh' | 'no_policy' | 'undated' }
  | {
      stale: true;
      dataType: string;
      /** Date (YYYY-MM-DD) the evidence stopped being fresh, or `undated`. */
      staleSince: string;
      rule: 'source_validity' | 'max_age';
      observedAt: string | null;
      validUntil: string | null;
      maxAgeDays: number | null;
    };

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function evaluateStaleness(
  evidence: EvidenceDates,
  policies: ReadonlyMap<string, FreshnessWindow>,
  asOf: Date,
): StalenessVerdict {
  const dataType = freshnessDataTypeFor(evidence.metric);
  const window = dataType ? policies.get(dataType) : undefined;
  if (!dataType || !window) return { stale: false, reason: 'no_policy' };
  const observedAt = evidence.observationPeriodEnd ?? evidence.sourceUpdatedAt ?? null;
  const validUntil = evidence.freshnessOverrideUntil ?? evidence.validUntil ?? null;
  if (!observedAt && !validUntil) return { stale: false, reason: 'undated' };
  const fresh = isFresh(
    {
      observedAt,
      validUntil,
      maxAgeDays: window.maxAgeDays,
      respectSourceValidity: window.respectSourceValidity,
    },
    asOf,
  );
  if (fresh) return { stale: false, reason: 'fresh' };
  const bySourceValidity = window.respectSourceValidity && Boolean(validUntil);
  let staleSince = 'undated';
  if (bySourceValidity) staleSince = validUntil!;
  else if (observedAt && window.maxAgeDays !== null)
    staleSince = isoDate(new Date(new Date(observedAt).getTime() + window.maxAgeDays * DAY_MS));
  return {
    stale: true,
    dataType,
    staleSince,
    rule: bySourceValidity ? 'source_validity' : 'max_age',
    observedAt,
    validUntil,
    maxAgeDays: window.maxAgeDays,
  };
}

export async function loadFreshnessWindows(tx: Transaction): Promise<Map<string, FreshnessWindow>> {
  const rows = await tx.select().from(schema.freshnessPolicies);
  return new Map(
    rows.map((r) => [
      r.dataType,
      { maxAgeDays: r.maxAgeDays, respectSourceValidity: r.respectSourceValidity },
    ]),
  );
}

interface Candidate extends EvidenceDates {
  observationId: string;
  observationSlug: string | null;
  geographyLabel: string;
  interpretationId: string;
  interpretationVersion: number;
  marketId: string | null;
}

async function loadCandidates(
  tx: Transaction,
  filter: { marketIds?: string[]; observationIds?: string[] },
): Promise<Candidate[]> {
  const o = schema.observations;
  const i = schema.observationInterpretations;
  const rows = await tx
    .select({
      observationId: o.id,
      observationSlug: o.slug,
      metric: o.metric,
      geographyLabel: o.geographyLabel,
      observationPeriodEnd: o.observationPeriodEnd,
      sourceUpdatedAt: o.sourceUpdatedAt,
      validUntil: o.validUntil,
      observationMarketId: o.marketId,
      interpretationId: i.id,
      interpretationVersion: i.version,
      freshnessOverrideUntil: i.freshnessOverrideUntil,
      appliesToMarketId: i.appliesToMarketId,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.observationId))
    .where(
      and(
        eq(i.isCurrent, true),
        eq(i.publicationState, 'published'),
        notInArray(i.reviewStatus, [...SETTLED_REVIEW_STATUSES]),
        filter.marketIds
          ? or(
              inArray(o.marketId, filter.marketIds),
              inArray(i.appliesToMarketId, filter.marketIds),
            )
          : undefined,
        filter.observationIds ? inArray(o.id, filter.observationIds) : undefined,
      ),
    );
  return rows.map((r) => ({
    ...r,
    marketId: r.observationMarketId ?? r.appliesToMarketId ?? null,
  }));
}

export interface RefreshTaskPayload {
  observationId: string;
  interpretationId: string;
  marketId: string;
  staleSince: string;
  dataType: string;
}

export interface SweepSummary {
  checked: number;
  stale: number;
  queued: number;
  alreadyQueued: number;
  /** Stale evidence with no market to file a research task against (statewide context). */
  withoutMarket: number;
}

export async function sweepStaleEvidence(
  db: Database,
  options: { asOf?: Date; marketIds?: string[]; correlationId?: string } = {},
): Promise<SweepSummary> {
  const asOf = options.asOf ?? new Date();
  return withActor(
    db,
    systemContext(options.correlationId ?? 'stale-evidence-sweep'),
    async (tx) => {
      const policies = await loadFreshnessWindows(tx);
      const candidates = await loadCandidates(tx, { marketIds: options.marketIds });
      const summary: SweepSummary = {
        checked: candidates.length,
        stale: 0,
        queued: 0,
        alreadyQueued: 0,
        withoutMarket: 0,
      };
      for (const c of candidates) {
        const verdict = evaluateStaleness(c, policies, asOf);
        if (!verdict.stale) continue;
        summary.stale += 1;
        if (!c.marketId) {
          summary.withoutMarket += 1;
          continue;
        }
        const payload: RefreshTaskPayload = {
          observationId: c.observationId,
          interpretationId: c.interpretationId,
          marketId: c.marketId,
          staleSince: verdict.staleSince,
          dataType: verdict.dataType,
        };
        const { deduplicated } = await enqueueJob(tx, {
          type: REFRESH_TASK_JOB,
          queue: 'default',
          payload: { ...payload },
          dedupeKey: refreshTaskDedupeKey(c.observationId, verdict.staleSince),
          maxAttempts: 5,
          correlationId: options.correlationId ?? null,
        });
        if (deduplicated) summary.alreadyQueued += 1;
        else summary.queued += 1;
      }
      return summary;
    },
  );
}

export function refreshTaskDedupeKey(observationId: string, staleSince: string): string {
  return `market_data.refresh:${observationId}:${staleSince}`;
}

/** Marker written into the task notes; identifies tasks this sweep opened for an observation. */
export function refreshTaskMarker(observationId: string): string {
  return `freshness-sweep:observation=${observationId}`;
}

const label = (metric: string): string => metric.replace(/_/g, ' ');

export type OpenRefreshTaskResult =
  | { status: 'created'; taskId: string }
  | {
      status: 'skipped';
      reason: 'not_found' | 'no_longer_published' | 'no_longer_stale' | 'open_task_exists';
    };

/**
 * Job body for `market_data.open_refresh_task`: re-checks the evidence under
 * the current policies, then opens one research task (unassigned, for the
 * data editors' queue) and records an audit entry. Never touches the
 * observation or its interpretation.
 */
export async function openRefreshTask(
  db: Database,
  payload: RefreshTaskPayload,
  options: { asOf?: Date; correlationId?: string | null } = {},
): Promise<OpenRefreshTaskResult> {
  const asOf = options.asOf ?? new Date();
  return withActor(db, systemContext(options.correlationId ?? undefined), async (tx) => {
    // Serialises concurrent task jobs for the same observation (different periods).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`research_task:${payload.observationId}`}))`,
    );
    const [candidate] = await loadCandidates(tx, { observationIds: [payload.observationId] });
    if (!candidate) {
      const [exists] = await tx
        .select({ id: schema.observations.id })
        .from(schema.observations)
        .where(eq(schema.observations.id, payload.observationId));
      return { status: 'skipped', reason: exists ? 'no_longer_published' : 'not_found' };
    }
    const policies = await loadFreshnessWindows(tx);
    const verdict = evaluateStaleness(candidate, policies, asOf);
    if (!verdict.stale) return { status: 'skipped', reason: 'no_longer_stale' };
    const marketId = candidate.marketId ?? payload.marketId;

    const marker = refreshTaskMarker(payload.observationId);
    const [open] = await tx
      .select({ id: schema.researchTasks.id })
      .from(schema.researchTasks)
      .where(
        and(
          eq(schema.researchTasks.marketId, marketId),
          ne(schema.researchTasks.status, 'done'),
          like(schema.researchTasks.notes, `%${marker}%`),
        ),
      )
      .limit(1);
    if (open) return { status: 'skipped', reason: 'open_task_exists' };

    const dueDate = isoDate(new Date(asOf.getTime() + 14 * DAY_MS));
    const notes = [
      `The published ${label(candidate.metric)} evidence for ${candidate.geographyLabel} is stale under the "${verdict.dataType}" freshness policy.`,
      `Observation: ${candidate.observationSlug ?? candidate.observationId} (interpretation v${candidate.interpretationVersion}).`,
      `Observation date: ${verdict.observedAt ?? 'unknown'}; valid until: ${verdict.validUntil ?? 'not stated'}; policy maximum age: ${verdict.maxAgeDays === null ? 'none' : `${verdict.maxAgeDays} days`}; stale since: ${verdict.staleSince}.`,
      'Published values were not changed. Collect and publish a newer observation, or review the interpretation (mark stale or record a freshness override with a reason).',
      marker,
    ].join('\n');
    const title = `Refresh stale evidence: ${label(candidate.metric)} (${candidate.geographyLabel})`;
    const [task] = await tx
      .insert(schema.researchTasks)
      .values({
        marketId,
        title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
        category: REFRESH_TASK_CATEGORY,
        status: 'open',
        priority: 2,
        dueDate,
        targetCount: 1,
        notes,
      })
      .returning({ id: schema.researchTasks.id });
    await tx.insert(schema.auditEvents).values({
      actorType: 'job',
      action: 'research_task.created',
      entityType: 'research_task',
      entityId: task!.id,
      after: {
        marketId,
        title,
        category: REFRESH_TASK_CATEGORY,
        source: 'freshness_sweep',
        observationId: payload.observationId,
        interpretationId: candidate.interpretationId,
        dataType: verdict.dataType,
        staleSince: verdict.staleSince,
        rule: verdict.rule,
      },
      reason: `freshness policy ${verdict.dataType}: stale since ${verdict.staleSince}`,
      correlationId: options.correlationId ?? null,
    });
    return { status: 'created', taskId: task!.id };
  });
}
