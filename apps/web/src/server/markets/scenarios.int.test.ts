import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  comparisonReportSchema,
  scenarioCreateSchema,
  scenarioDtoSchema,
  scenarioListQuerySchema,
  scenarioSnapshotResponseSchema,
  scenarioVerificationRequestSchema,
  sharedScenarioResponseSchema,
  type ScenarioCreate,
} from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import {
  ANONYMOUS_SCENARIO_LIMIT,
  buildScenarioReport,
  claimScenario,
  createScenario,
  deleteScenario,
  getScenario,
  getSharedScenario,
  listScenarios,
  requestVerification,
  shareScenario,
  snapshotScenario,
  updateScenario,
} from './scenarios';
import {
  anonymousIdentity,
  insertUser,
  seedAndPublish,
  staffIdentity,
  userIdentity,
} from './test-fixtures';

let dbs: TestDatabases;
const tokenA = anonymousIdentity('tok-A');
const tokenB = anonymousIdentity('tok-B');
const user = userIdentity('user-scenarios', 'tok-A');
let lagosId: string;
let ikejaId: string;

function scenarioInput(overrides: Partial<ScenarioCreate> = {}): ScenarioCreate {
  return scenarioCreateSchema.parse({
    name: 'Lagos vs Ikeja',
    objective: 'long_term_rent',
    mode: 'assumption',
    filters: { totalBudgetNaira: 150_000_000 },
    assumptions: {
      base: {
        landCostNaira: 20_000_000,
        grossFloorAreaM2: 400,
        buildRateNairaPerM2: 200_000,
        units: [{ label: 'flats', count: 2, annualRentPerUnitNaira: 3_000_000 }],
        vacancyRate: 0.1,
        opex: { maintenanceNaira: 1_200_000 },
      },
    },
    marketIds: [lagosId, ikejaId],
    ...overrides,
  });
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedAndPublish(dbs.owner);
  await insertUser(dbs.owner, 'user-scenarios');
  await insertUser(dbs.owner, 'staff-scenarios');
  const rows = await dbs.owner
    .select({ id: schema.markets.id, slug: schema.markets.slug })
    .from(schema.markets);
  lagosId = rows.find((r) => r.slug === 'ng-lagos')!.id;
  ikejaId = rows.find((r) => r.slug === 'ng-ikeja')!.id;
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('anonymous scenarios', () => {
  it('are visible only through the token that saved them and can be claimed by a signed-in user', async () => {
    const created = await createScenario(scenarioInput(), tokenA, 'corr-1');
    expect(() => scenarioDtoSchema.parse(created)).not.toThrow();
    expect(created.isAnonymous).toBe(true);
    expect(created.ownerUserId).toBeNull();
    expect(created.marketIds).toEqual([lagosId, ikejaId]);

    expect((await getScenario(created.id, tokenA)).id).toBe(created.id);
    await expect(getScenario(created.id, tokenB)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listScenarios(scenarioListQuerySchema.parse({}), tokenB)).items).toEqual([]);
    expect(
      (await listScenarios(scenarioListQuerySchema.parse({}), tokenA)).items.map((s) => s.id),
    ).toEqual([created.id]);

    // A signed-in user carrying a different token cannot claim it.
    await expect(
      claimScenario(created.id, userIdentity('user-scenarios', 'tok-B'), 'corr-2'),
    ).rejects.toMatchObject({ code: 'not_found' });

    const claimed = await claimScenario(created.id, user, 'corr-3');
    expect(claimed.ownerUserId).toBe('user-scenarios');
    expect(claimed.isAnonymous).toBe(false);
    // The anonymous token no longer opens it; the account does.
    await expect(getScenario(created.id, tokenA)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getScenario(created.id, userIdentity('user-scenarios'))).id).toBe(created.id);
    // Staff can see it (privileged) but a stranger cannot.
    expect((await getScenario(created.id, staffIdentity('staff-scenarios'))).id).toBe(created.id);
  });

  it('require the feature flag and an anonymous token', async () => {
    await expect(
      createScenario(
        scenarioInput(),
        anonymousIdentity('tok-C', { 'core.anonymous_scenarios': false }),
        'c',
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      createScenario(scenarioInput(), anonymousIdentity(null), 'c'),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it(`are limited to ${ANONYMOUS_SCENARIO_LIMIT} per token`, async () => {
    const identity = anonymousIdentity('tok-quota');
    for (let i = 0; i < ANONYMOUS_SCENARIO_LIMIT; i += 1) {
      await createScenario(scenarioInput({ name: `Scenario ${i}` }), identity, 'q');
    }
    await expect(
      createScenario(scenarioInput({ name: 'one too many' }), identity, 'q'),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const page = await listScenarios(scenarioListQuerySchema.parse({ limit: '8' }), identity);
    expect(page.items).toHaveLength(8);
    expect(page.nextCursor).not.toBeNull();
    const rest = await listScenarios(
      scenarioListQuerySchema.parse({ limit: '50', cursor: page.nextCursor! }),
      identity,
    );
    expect(rest.items).toHaveLength(ANONYMOUS_SCENARIO_LIMIT - 8);
    expect(new Set([...page.items, ...rest.items].map((s) => s.id)).size).toBe(
      ANONYMOUS_SCENARIO_LIMIT,
    );
  });

  it('rejects unknown market ids', async () => {
    await expect(
      createScenario(
        scenarioInput({ marketIds: ['00000000-0000-4000-8000-000000000000'] }),
        tokenA,
        'c',
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('updates and deletion', () => {
  it('uses expectedUpdatedAt for optimistic concurrency and soft-deletes', async () => {
    const created = await createScenario(scenarioInput({ name: 'to update' }), tokenA, 'u');
    await expect(
      updateScenario(
        created.id,
        { name: 'stale', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' },
        tokenA,
        'u',
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const updated = await updateScenario(
      created.id,
      { name: 'fresh name', expectedUpdatedAt: created.updatedAt },
      tokenA,
      'u',
    );
    expect(updated.name).toBe('fresh name');
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    await expect(updateScenario(created.id, { name: 'x' }, tokenB, 'u')).rejects.toMatchObject({
      code: 'not_found',
    });
    await deleteScenario(created.id, tokenA, 'u');
    await expect(getScenario(created.id, tokenA)).rejects.toMatchObject({ code: 'not_found' });
    const [row] = await dbs.owner
      .select()
      .from(schema.scenarios)
      .where(eq(schema.scenarios.id, created.id));
    expect(row?.expiresAt).not.toBeNull();
  });
});

describe('snapshots, reports, sharing and verification', () => {
  it('stores policy version 1, inputs and source versions, and reports from the stored snapshot', async () => {
    const created = await createScenario(scenarioInput({ name: 'snapshot me' }), tokenA, 's');
    const snapshot = await snapshotScenario(created.id, tokenA, 's');
    expect(() => scenarioSnapshotResponseSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.policyVersion).toBe(1);
    expect(snapshot.recommendation.snapshotId).toBe(snapshot.snapshotId);
    expect(snapshot.recommendation.organic.map((m) => m.marketId).sort()).toEqual(
      [lagosId, ikejaId].sort(),
    );
    expect(snapshot.sourceVersions['ranking_policy']).toMatch(/^v1:/);

    const [row] = await dbs.owner
      .select()
      .from(schema.recommendationSnapshots)
      .where(eq(schema.recommendationSnapshots.id, snapshot.snapshotId));
    expect(row?.policyVersion).toBe(1);
    const inputs = row?.inputs as {
      marketInputs: unknown[];
      generatedFrom: { inputsHash: string };
    };
    expect(inputs.marketInputs).toHaveLength(2);
    expect(inputs.generatedFrom.inputsHash).toBe(snapshot.inputsHash);
    const [scenarioRow] = await dbs.owner
      .select()
      .from(schema.scenarios)
      .where(eq(schema.scenarios.id, created.id));
    expect(scenarioRow?.policyVersion).toBe(1);

    const report = await buildScenarioReport(created.id, tokenA, 's');
    expect(() => comparisonReportSchema.parse(report)).not.toThrow();
    expect(report.snapshot.id).toBe(snapshot.snapshotId);
    expect(report.markets.map((m) => m.marketId)).toEqual([lagosId, ikejaId]);
    expect(report.overlapWarnings).toHaveLength(1);
    expect(report.rows).toHaveLength(7);
    const reports = await dbs.owner
      .select()
      .from(schema.comparisonReports)
      .where(eq(schema.comparisonReports.scenarioId, created.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.snapshotId).toBe(snapshot.snapshotId);

    // Old snapshots are never recomputed: a second report still reads the same snapshot.
    const again = await buildScenarioReport(created.id, tokenA, 's');
    expect(again.snapshot.id).toBe(snapshot.snapshotId);
  });

  it('creates a snapshot on demand when a report is requested without one', async () => {
    const created = await createScenario(scenarioInput({ name: 'report first' }), tokenA, 'r');
    const report = await buildScenarioReport(created.id, tokenA, 'r');
    expect(report.snapshot.policyVersion).toBe(1);
    const rows = await dbs.owner
      .select()
      .from(schema.recommendationSnapshots)
      .where(eq(schema.recommendationSnapshots.scenarioId, created.id));
    expect(rows).toHaveLength(1);
  });

  it('shares privately with an expiring token (account required) and serves a read-only view', async () => {
    const created = await createScenario(
      scenarioInput({ name: 'shared' }),
      userIdentity('user-scenarios'),
      'sh',
    );
    await expect(
      shareScenario(created.id, { expiresInDays: 7 }, tokenA, 'sh'),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await snapshotScenario(created.id, userIdentity('user-scenarios'), 'sh');
    const share = await shareScenario(
      created.id,
      { expiresInDays: 7 },
      userIdentity('user-scenarios'),
      'sh',
    );
    expect(share.sharePath).toBe(`/api/v1/scenarios/shared/${share.shareToken}`);
    const shared = await getSharedScenario(share.shareToken);
    expect(() => sharedScenarioResponseSchema.parse(shared)).not.toThrow();
    expect(shared.readOnly).toBe(true);
    expect(shared.scenario.id).toBe(created.id);
    expect(shared.scenario.ownerUserId).toBeNull();
    expect(shared.scenario.shareToken).toBeNull();
    expect(shared.snapshot?.policyVersion).toBe(1);
    await expect(getSharedScenario('not-a-real-token-value')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('records a map_scenario lead when verification is requested', async () => {
    const created = await createScenario(scenarioInput({ name: 'verify me' }), tokenA, 'v');
    const body = scenarioVerificationRequestSchema.parse({
      contactName: 'Ada Lovelace',
      email: 'ada@example.test',
      message: 'Please verify these two markets.',
      elapsedMs: 5000,
    });
    const result = await requestVerification(created.id, body, tokenA, {
      ipHash: 'iphash',
      userAgent: 'vitest',
      correlationId: 'v',
    });
    expect(result.leadStatus).toBe('new');
    const [lead] = await dbs.owner
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, result.leadId));
    expect(lead?.source).toBe('map_scenario');
    expect(lead?.scenarioId).toBe(created.id);
    expect((lead?.context as { marketIds: string[]; budgetNaira: number }).marketIds).toEqual([
      lagosId,
      ikejaId,
    ]);
    expect((lead?.context as { budgetNaira: number }).budgetNaira).toBe(150_000_000);
    const after = await getScenario(created.id, tokenA);
    expect(after.verificationRequestedAt).not.toBeNull();
    await expect(
      requestVerification(created.id, body, tokenB, {
        ipHash: null,
        userAgent: null,
        correlationId: 'v',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
