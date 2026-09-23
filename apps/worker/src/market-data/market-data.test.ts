import { and, eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type Database } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import {
  deleteKeysMatching,
  invalidateMarketCaches,
  MARKET_CACHE_PATTERN,
  redisKeyStore,
  type CacheKeyStore,
} from './cache';
import {
  evaluateStaleness,
  openRefreshTask,
  REFRESH_TASK_CATEGORY,
  REFRESH_TASK_JOB,
  refreshTaskDedupeKey,
  sweepStaleEvidence,
  type EvidenceDates,
  type FreshnessWindow,
} from './stale-evidence';

const asOf = new Date('2026-09-23T12:00:00Z');
const policies = new Map<string, FreshnessWindow>([
  ['rent_observation', { maxAgeDays: 90, respectSourceValidity: true }],
  ['official_risk_layer', { maxAgeDays: null, respectSourceValidity: true }],
  ['sale_observation', { maxAgeDays: 90, respectSourceValidity: false }],
]);
const dates = (over: Partial<EvidenceDates>): EvidenceDates => ({
  metric: 'median_annual_rent_ngn',
  observationPeriodEnd: null,
  sourceUpdatedAt: null,
  validUntil: null,
  freshnessOverrideUntil: null,
  ...over,
});

describe('evaluateStaleness', () => {
  it('is fresh inside the maximum age and stale after it, dated from the period end', () => {
    expect(
      evaluateStaleness(dates({ observationPeriodEnd: '2026-08-01' }), policies, asOf),
    ).toEqual({
      stale: false,
      reason: 'fresh',
    });
    expect(
      evaluateStaleness(dates({ observationPeriodEnd: '2026-05-01' }), policies, asOf),
    ).toEqual({
      stale: true,
      dataType: 'rent_observation',
      staleSince: '2026-07-30',
      rule: 'max_age',
      observedAt: '2026-05-01',
      validUntil: null,
      maxAgeDays: 90,
    });
  });

  it('falls back to the source update date, never the retrieval date', () => {
    const v = evaluateStaleness(dates({ sourceUpdatedAt: '2026-01-01' }), policies, asOf);
    expect(v).toMatchObject({ stale: true, staleSince: '2026-04-01', observedAt: '2026-01-01' });
  });

  it('honours source validity when the policy respects it, and an editorial override wins', () => {
    const lapsed = dates({ observationPeriodEnd: '2026-09-01', validUntil: '2026-09-10' });
    expect(evaluateStaleness(lapsed, policies, asOf)).toMatchObject({
      stale: true,
      rule: 'source_validity',
      staleSince: '2026-09-10',
    });
    const extended = { ...lapsed, freshnessOverrideUntil: '2026-12-31' };
    expect(evaluateStaleness(extended, policies, asOf)).toEqual({ stale: false, reason: 'fresh' });
    // An override that lapsed starts a new staleness period.
    expect(
      evaluateStaleness({ ...lapsed, freshnessOverrideUntil: '2026-09-20' }, policies, asOf),
    ).toMatchObject({ stale: true, staleSince: '2026-09-20' });
  });

  it('ignores source validity when the policy does not respect it', () => {
    const v = evaluateStaleness(
      dates({
        metric: 'median_asking_sale_price',
        observationPeriodEnd: '2026-01-01',
        validUntil: '2027-01-01',
      }),
      policies,
      asOf,
    );
    expect(v).toMatchObject({ stale: true, rule: 'max_age', staleSince: '2026-04-01' });
  });

  it('never marks evidence stale without a policy, without dates, or with no maximum age', () => {
    expect(
      evaluateStaleness(
        dates({ metric: 'demand_index', observationPeriodEnd: '2020-01-01' }),
        policies,
        asOf,
      ),
    ).toEqual({ stale: false, reason: 'no_policy' });
    expect(evaluateStaleness(dates({}), policies, asOf)).toEqual({
      stale: false,
      reason: 'undated',
    });
    expect(
      evaluateStaleness(
        dates({ metric: 'flood_risk_index', observationPeriodEnd: '2001-01-01' }),
        policies,
        asOf,
      ),
    ).toEqual({ stale: false, reason: 'fresh' });
  });
});

describe('market cache invalidation', () => {
  function fakeStore(keys: string[]): CacheKeyStore & { patterns: string[]; deleted: string[] } {
    const pages = [keys.slice(0, 2), keys.slice(2)];
    const store = {
      patterns: [] as string[],
      deleted: [] as string[],
      scan: async (cursor: string, pattern: string) => {
        store.patterns.push(pattern);
        return cursor === '0'
          ? (['7', pages[0]!] as [string, string[]])
          : (['0', pages[1]!] as [string, string[]]);
      },
      del: async (batch: string[]) => {
        store.deleted.push(...batch);
        return batch.length;
      },
    };
    return store;
  }

  it('deletes the keys the web app caches market read models under, following the SCAN cursor', async () => {
    const store = fakeStore(['cache:markets:geojson:v1', 'cache:markets:a', 'cache:markets:b']);
    expect(await invalidateMarketCaches(store)).toBe(3);
    expect(store.patterns).toEqual([MARKET_CACHE_PATTERN, MARKET_CACHE_PATTERN]);
    expect(MARKET_CACHE_PATTERN).toBe('cache:markets*');
    expect(store.deleted).toEqual([
      'cache:markets:geojson:v1',
      'cache:markets:a',
      'cache:markets:b',
    ]);
  });

  it('works against a real Redis without touching other keys', async (ctx) => {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
    });
    try {
      await redis.connect();
    } catch {
      redis.disconnect();
      ctx.skip('Redis is not reachable');
      return;
    }
    const run = uniqueSuffix();
    try {
      await redis.set(`cache:markets:test-${run}:1`, 'x', 'EX', 60);
      await redis.set(`cache:markets:test-${run}:2`, 'x', 'EX', 60);
      await redis.set(`cache:content:test-${run}`, 'x', 'EX', 60);
      const deleted = await deleteKeysMatching(
        redisKeyStore(redis),
        `cache:markets:test-${run}*`,
        1,
      );
      expect(deleted).toBe(2);
      expect(await redis.exists(`cache:markets:test-${run}:1`)).toBe(0);
      expect(await redis.exists(`cache:content:test-${run}`)).toBe(1);
    } finally {
      await redis.del(`cache:content:test-${run}`);
      await redis.quit();
    }
  });
});

describe('stale evidence sweep', () => {
  let dbs: TestDatabases;
  const run = uniqueSuffix();
  let marketId: string;
  const obs: Record<
    'stale' | 'fresh' | 'draft',
    { observationId: string; interpretationId: string }
  > = {} as never;

  async function insertObservation(
    owner: Database,
    sourceId: string,
    key: string,
    over: { periodEnd: string; publicationState: 'published' | 'draft' },
  ) {
    const [o] = await owner
      .insert(schema.observations)
      .values({
        slug: `sweep-${run}-${key}`,
        sourceId,
        metric: 'median_annual_rent_ngn',
        valueNumeric: '1000000',
        unit: 'NGN/year',
        geographyLevel: 'city',
        geographyLabel: `Sweep City ${run}`,
        marketId,
        propertyCohort: '2-bedroom flat',
        statistic: 'median',
        observationPeriodEnd: over.periodEnd,
        retrievedAt: '2026-09-01',
      })
      .returning({ id: schema.observations.id });
    const [i] = await owner
      .insert(schema.observationInterpretations)
      .values({
        observationId: o!.id,
        version: 1,
        reviewStatus: 'verified',
        publicationState: over.publicationState,
        rankEligible: true,
        publishedAt: over.publicationState === 'published' ? new Date() : null,
      })
      .returning({ id: schema.observationInterpretations.id });
    return { observationId: o!.id, interpretationId: i!.id };
  }

  beforeAll(async () => {
    dbs = connectTestDatabases();
    const owner = dbs.owner;
    await owner
      .insert(schema.countries)
      .values({ code: 'NG', name: 'Nigeria' })
      .onConflictDoNothing();
    await owner
      .insert(schema.freshnessPolicies)
      .values({ dataType: 'rent_observation', maxAgeDays: 90, respectSourceValidity: true })
      .onConflictDoNothing();
    const [state] = await owner
      .insert(schema.states)
      .values({ countryCode: 'NG', name: `Sweep State ${run}`, geopoliticalZone: 'SW' })
      .returning({ id: schema.states.id });
    const [source] = await owner
      .insert(schema.sources)
      .values({ slug: `sweep-source-${run}`, title: 'Sweep test source' })
      .returning({ id: schema.sources.id });
    const [market] = await owner
      .insert(schema.markets)
      .values({
        slug: `sweep-market-${run}`,
        name: `Sweep ${run}`,
        countryCode: 'NG',
        stateId: state!.id,
        geopoliticalZone: 'SW',
        location: { lon: 3.4, lat: 6.5 },
        publicationState: 'published',
      })
      .returning({ id: schema.markets.id });
    marketId = market!.id;
    obs.stale = await insertObservation(owner, source!.id, 'stale', {
      periodEnd: '2020-01-31',
      publicationState: 'published',
    });
    obs.fresh = await insertObservation(owner, source!.id, 'fresh', {
      periodEnd: new Date().toISOString().slice(0, 10),
      publicationState: 'published',
    });
    obs.draft = await insertObservation(owner, source!.id, 'draft', {
      periodEnd: '2020-01-31',
      publicationState: 'draft',
    });
  });

  afterAll(async () => {
    const owner = dbs.owner;
    const observationIds = Object.values(obs).map((o) => o.observationId);
    for (const id of observationIds)
      await owner
        .delete(schema.jobs)
        .where(like(schema.jobs.dedupeKey, `market_data.refresh:${id}:%`));
    await owner.delete(schema.researchTasks).where(eq(schema.researchTasks.marketId, marketId));
    await owner
      .delete(schema.observationInterpretations)
      .where(inArray(schema.observationInterpretations.observationId, observationIds));
    // Observations are append-only (and the market, source and state they reference stay
    // with them); without an interpretation they are never published or swept.
    await dbs.close();
  });

  const refreshJobs = (observationId: string) =>
    dbs.owner
      .select()
      .from(schema.jobs)
      .where(like(schema.jobs.dedupeKey, `market_data.refresh:${observationId}:%`));

  it('queues one refresh job per stale published observation per period, idempotently', async () => {
    const first = await sweepStaleEvidence(dbs.app, { marketIds: [marketId] });
    expect(first).toEqual({ checked: 2, stale: 1, queued: 1, alreadyQueued: 0, withoutMarket: 0 });
    const jobs = await refreshJobs(obs.stale.observationId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: REFRESH_TASK_JOB,
      queue: 'default',
      status: 'pending',
      dedupeKey: refreshTaskDedupeKey(obs.stale.observationId, '2020-04-30'),
    });
    expect(jobs[0]!.payload).toEqual({
      observationId: obs.stale.observationId,
      interpretationId: obs.stale.interpretationId,
      marketId,
      staleSince: '2020-04-30',
      dataType: 'rent_observation',
    });
    expect(await refreshJobs(obs.fresh.observationId)).toEqual([]);
    expect(await refreshJobs(obs.draft.observationId)).toEqual([]);

    const again = await sweepStaleEvidence(dbs.app, { marketIds: [marketId] });
    expect(again).toMatchObject({ stale: 1, queued: 0, alreadyQueued: 1 });
    expect(await refreshJobs(obs.stale.observationId)).toHaveLength(1);
  });

  it('opens one research task for data editors without altering published data', async () => {
    const [before] = await dbs.owner
      .select()
      .from(schema.observationInterpretations)
      .where(eq(schema.observationInterpretations.id, obs.stale.interpretationId));
    const payload = {
      observationId: obs.stale.observationId,
      interpretationId: obs.stale.interpretationId,
      marketId,
      staleSince: '2020-04-30',
      dataType: 'rent_observation',
    };
    const created = await openRefreshTask(dbs.app, payload, { correlationId: `corr-${run}` });
    expect(created.status).toBe('created');
    const taskId = (created as { taskId: string }).taskId;

    const [task] = await dbs.owner
      .select()
      .from(schema.researchTasks)
      .where(eq(schema.researchTasks.id, taskId));
    expect(task).toMatchObject({
      marketId,
      category: REFRESH_TASK_CATEGORY,
      status: 'open',
      priority: 2,
      assigneeUserId: null,
      title: `Refresh stale evidence: median annual rent ngn (Sweep City ${run})`,
    });
    expect(task!.notes).toContain('stale since: 2020-04-30');
    expect(task!.notes).toContain(`freshness-sweep:observation=${obs.stale.observationId}`);

    const [audit] = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'research_task'),
          eq(schema.auditEvents.entityId, taskId),
        ),
      );
    expect(audit).toMatchObject({
      actorType: 'job',
      action: 'research_task.created',
      correlationId: `corr-${run}`,
    });
    expect(audit!.after).toMatchObject({ source: 'freshness_sweep', staleSince: '2020-04-30' });

    // A retried job (or another period while the task is still open) never adds a second task.
    expect(await openRefreshTask(dbs.app, payload)).toEqual({
      status: 'skipped',
      reason: 'open_task_exists',
    });
    const tasks = await dbs.owner
      .select()
      .from(schema.researchTasks)
      .where(eq(schema.researchTasks.marketId, marketId));
    expect(tasks).toHaveLength(1);

    const [after] = await dbs.owner
      .select()
      .from(schema.observationInterpretations)
      .where(eq(schema.observationInterpretations.id, obs.stale.interpretationId));
    expect(after).toEqual(before);
  });

  it('re-checks before opening a task: fresh or unpublished evidence is skipped', async () => {
    const base = { marketId, staleSince: '2020-04-30', dataType: 'rent_observation' };
    expect(
      await openRefreshTask(dbs.app, {
        ...base,
        observationId: obs.fresh.observationId,
        interpretationId: obs.fresh.interpretationId,
      }),
    ).toEqual({ status: 'skipped', reason: 'no_longer_stale' });
    expect(
      await openRefreshTask(dbs.app, {
        ...base,
        observationId: obs.draft.observationId,
        interpretationId: obs.draft.interpretationId,
      }),
    ).toEqual({ status: 'skipped', reason: 'no_longer_published' });
    expect(
      await openRefreshTask(dbs.app, {
        ...base,
        observationId: '00000000-0000-4000-8000-000000000000',
        interpretationId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({ status: 'skipped', reason: 'not_found' });
  });
});
