import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { importMarketSeed, seedReferenceData } from '@simplexd/db/seed';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import {
  createObservation,
  getObservation,
  listObservations,
  reviewObservation,
} from './observations';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.resolve(here, '../../../../../../data/seed/nigeria-50-markets.seed.json');

let dbs: TestDatabases;
let editor: AdminContext;
let approver: AdminContext;
let approver2: AdminContext;
let approverNoMfa: AdminContext;
let ibadanId: string;
let sourceId: string;

const users = {
  editor: { id: 'user_editor_ob', name: 'Edith Editor', email: 'editor-ob@example.test' },
  approver: { id: 'user_approver_ob', name: 'Ada Approver', email: 'approver-ob@example.test' },
  approver2: { id: 'user_approver2_ob', name: 'Bola Approver', email: 'approver2-ob@example.test' },
};

function baseObservation(overrides: Partial<Parameters<typeof createObservation>[1]> = {}) {
  return {
    sourceId,
    metric: 'annual_rent_median',
    statistic: 'median' as const,
    value: 2_400_000,
    unit: 'NGN/year',
    numericRepresentation: 'whole_naira_not_kobo' as const,
    geographyLevel: 'city' as const,
    geographyLabel: 'Ibadan',
    marketId: ibadanId,
    propertyCohort: '3-bedroom flat',
    retrievedAt: '2026-09-21',
    sampleSize: 40,
    ...overrides,
  };
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedReferenceData(dbs.owner);
  await importMarketSeed(dbs.owner, JSON.parse(fs.readFileSync(seedFile, 'utf8')));
  await insertStaffUser(dbs.owner, users.editor, ['data_editor']);
  await insertStaffUser(dbs.owner, users.approver, ['data_approver']);
  await insertStaffUser(dbs.owner, users.approver2, ['data_approver']);
  editor = contextFor(dbs.app, identityFor(users.editor, ['data_editor']));
  approver = contextFor(dbs.app, identityFor(users.approver, ['data_approver']));
  approver2 = contextFor(dbs.app, identityFor(users.approver2, ['data_approver']));
  approverNoMfa = contextFor(
    dbs.app,
    identityFor(users.approver, ['data_approver'], { mfaVerified: false }),
  );
  const [ibadan] = await dbs.owner
    .select()
    .from(schema.markets)
    .where(eq(schema.markets.slug, 'ng-ibadan'));
  ibadanId = ibadan!.id;
  const [src] = await dbs.owner
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.slug, 'npc-q3-2026'));
  sourceId = src!.id;
});

afterAll(async () => {
  await dbs.close();
});

describe('observation review workflow', () => {
  let observationId: string;

  it('editor submits an observation: immutable row, interpretation v1 and a submission review', async () => {
    const dto = await createObservation(editor, baseObservation({ slug: 'test-ibadan-rent-3bed' }));
    observationId = dto.id;
    expect(dto.interpretation.version).toBe(1);
    expect(dto.interpretation.reviewStatus).toBe('source_read_pending_business_review');
    expect(dto.interpretation.publicationState).toBe('draft');
    const reviews = await dbs.owner
      .select()
      .from(schema.observationReviews)
      .where(eq(schema.observationReviews.observationId, observationId));
    expect(reviews.map((r) => r.decision)).toEqual(['submitted']);
    const queue = await listObservations(editor, {
      pendingOnly: true,
      sort: 'createdAt',
      order: 'desc',
      page: 1,
      pageSize: 50,
    });
    expect(queue.items.some((o) => o.id === observationId)).toBe(true);
  });

  it('editor cannot publish; approver without MFA cannot publish', async () => {
    await expect(
      reviewObservation(editor, observationId, {
        decision: 'publish',
        expectedVersion: 1,
        publishAsContextual: false,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthorizationError && e.decision.code === 'no_permission',
    );
    await expect(
      reviewObservation(approverNoMfa, observationId, {
        decision: 'publish',
        expectedVersion: 1,
        publishAsContextual: false,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthorizationError && e.decision.code === 'mfa_required',
    );
  });

  it('blocks publishing a local median below the comparables threshold unless published as contextual', async () => {
    await expect(
      reviewObservation(approver, observationId, {
        decision: 'publish',
        expectedVersion: 1,
        publishAsContextual: false,
      }),
    ).rejects.toMatchObject({
      code: 'insufficient_evidence',
      details: expect.objectContaining({
        applicable: true,
        count: 1,
        minComparables: 10,
        satisfied: false,
      }),
    });
    const result = await reviewObservation(approver, observationId, {
      decision: 'publish',
      expectedVersion: 1,
      publishAsContextual: true,
      note: 'Single published report; contextual only',
    });
    const i = result.observation.interpretation;
    expect(i.version).toBe(2);
    expect(i.publicationState).toBe('published');
    expect(i.reviewStatus).toBe('verified');
    expect(i.rankEligible).toBe(false);
    expect(i.reasonNotRankEligible).toMatch(/contextual evidence.*1 of 10/);
    expect(result.invalidatedPublicData).toBe(true);
    const previous = await dbs.owner
      .select()
      .from(schema.observationInterpretations)
      .where(
        and(
          eq(schema.observationInterpretations.observationId, observationId),
          eq(schema.observationInterpretations.version, 1),
        ),
      );
    expect(previous[0]!.isCurrent).toBe(false);
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, observationId));
    expect(outbox.map((o) => o.eventType)).toContain('market_data.published');
  });

  it('rejects a stale expectedVersion', async () => {
    await expect(
      reviewObservation(approver, observationId, {
        decision: 'unpublish',
        expectedVersion: 1,
        note: 'stale',
        publishAsContextual: false,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('an approver cannot publish or approve their own interpretation (own_work) but another approver can', async () => {
    const own = await createObservation(
      approver2,
      baseObservation({ metric: 'sale_price_median', unit: 'NGN', value: 40_000_000 }),
    );
    await expect(
      reviewObservation(approver2, own.id, {
        decision: 'publish',
        expectedVersion: 1,
        publishAsContextual: true,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthorizationError && e.decision.code === 'own_work',
    );
    await expect(
      reviewObservation(approver2, own.id, {
        decision: 'approve',
        expectedVersion: 1,
        publishAsContextual: false,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthorizationError && e.decision.code === 'own_work',
    );
    const approved = await reviewObservation(approver, own.id, {
      decision: 'approve',
      expectedVersion: 1,
      publishAsContextual: false,
    });
    expect(approved.observation.interpretation.reviewStatus).toBe('verified');
    expect(approved.observation.interpretation.reviewerId).toBe(users.approver.id);
  });

  it('never marks statewide context rank-eligible and counts deduplicated comparables per metric and cohort', async () => {
    const [oyo] = await dbs.owner.select().from(schema.states).where(eq(schema.states.name, 'Oyo'));
    const statewide = await createObservation(
      editor,
      baseObservation({
        geographyLevel: 'state_or_fct',
        geographyLabel: 'Oyo State',
        marketId: null,
        stateId: oyo!.id,
      }),
    );
    const published = await reviewObservation(approver, statewide.id, {
      decision: 'publish',
      expectedVersion: 1,
      publishAsContextual: false,
    });
    expect(published.observation.comparables.applicable).toBe(false);
    await expect(
      reviewObservation(approver, statewide.id, {
        decision: 'mark_rank_eligible',
        expectedVersion: 2,
        note: 'try',
        publishAsContextual: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const detail = await getObservation(editor, observationId);
    expect(detail.comparables.count).toBe(1);
    expect(detail.history.map((h) => h.version)).toEqual([2, 1]);
  });
});
