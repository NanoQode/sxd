import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { importMarketSeed, seedReferenceData } from '@simplexd/db/seed';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import {
  createMarket,
  getMarket,
  listMarkets,
  listRevisions,
  mergeMarket,
  patchMarket,
  rollbackMarket,
  transitionMarket,
} from './markets';
import { createObservation } from './observations';
import { createResearchTask } from './research-tasks';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.resolve(here, '../../../../../../data/seed/nigeria-50-markets.seed.json');

let dbs: TestDatabases;
let editor: AdminContext;
let approver: AdminContext;
let stateId: string;
let sourceId: string;

const users = {
  editor: { id: 'user_editor_mk', name: 'Edith Editor', email: 'editor-mk@example.test' },
  approver: { id: 'user_approver_mk', name: 'Ada Approver', email: 'approver-mk@example.test' },
};

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedReferenceData(dbs.owner);
  await importMarketSeed(dbs.owner, JSON.parse(fs.readFileSync(seedFile, 'utf8')));
  await insertStaffUser(dbs.owner, users.editor, ['data_editor']);
  await insertStaffUser(dbs.owner, users.approver, ['data_approver']);
  editor = contextFor(dbs.app, identityFor(users.editor, ['data_editor']));
  approver = contextFor(dbs.app, identityFor(users.approver, ['data_approver']));
  const [oyo] = await dbs.owner.select().from(schema.states).where(eq(schema.states.name, 'Oyo'));
  stateId = oyo!.id;
  const [src] = await dbs.owner
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.slug, 'npc-q3-2026'));
  sourceId = src!.id;
});

afterAll(async () => {
  await dbs.close();
});

describe('market administration', () => {
  let marketId: string;

  it('lets a data editor create a 51st draft market with a revision and audit entry', async () => {
    const row = await createMarket(editor, {
      slug: 'ng-iseyin',
      name: 'Iseyin',
      aliases: [],
      stateId,
      geopoliticalZone: 'SW',
      displayOrder: 51,
      location: { lon: 3.6, lat: 7.97 },
      serviceAvailability: 'pending_operations_confirmation',
      changeReason: 'Editorial addition',
    });
    marketId = row.id;
    expect(row.publicationState).toBe('draft');
    expect(row.version).toBe(1);
    const list = await listMarkets(editor, { sort: 'name', order: 'asc', page: 1, pageSize: 200 });
    expect(list.total).toBe(51);
    const revisions = await listRevisions(editor, marketId);
    expect(revisions.map((r) => r.version)).toEqual([1]);
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, marketId),
          eq(schema.auditEvents.action, 'market.created'),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it('rejects coordinates outside Nigeria', async () => {
    await expect(
      createMarket(editor, {
        slug: 'ng-nowhere',
        name: 'Nowhere',
        aliases: [],
        stateId,
        geopoliticalZone: 'SW',
        displayOrder: 52,
        location: { lon: 7.97, lat: 3.6 },
        serviceAvailability: 'pending_operations_confirmation',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('returns version_conflict for a stale patch and applies a fresh one', async () => {
    await expect(
      patchMarket(editor, marketId, {
        name: 'Iseyin Town',
        expectedVersion: 99,
        changeReason: 'stale attempt',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const updated = await patchMarket(editor, marketId, {
      name: 'Iseyin Town',
      expectedVersion: 1,
      changeReason: 'Corrected display name',
    });
    expect(updated.version).toBe(2);
    expect(updated.humanEditedAt).not.toBeNull();
  });

  it('rolls back to an earlier revision as a new revision with an audit entry', async () => {
    const rolled = await rollbackMarket(editor, marketId, {
      revisionVersion: 1,
      expectedVersion: 2,
      reason: 'Name change was wrong',
    });
    expect(rolled.version).toBe(3);
    expect(rolled.name).toBe('Iseyin');
    const revisions = await listRevisions(editor, marketId);
    expect(revisions.map((r) => r.version)).toEqual([3, 2, 1]);
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, marketId),
          eq(schema.auditEvents.action, 'market.rolled_back'),
        ),
      );
    expect(audit).toHaveLength(1);
    expect((audit[0]!.after as { restoredRevision: number }).restoredRevision).toBe(1);
  });

  it('only lets an approver publish, records the outbox event and requires the approver for later edits', async () => {
    await expect(
      transitionMarket(editor, marketId, 'publish', { expectedVersion: 3, reason: 'ready' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const published = await transitionMarket(approver, marketId, 'publish', {
      expectedVersion: 3,
      reason: 'Reviewed profile',
    });
    expect(published.publicationState).toBe('published');
    expect(published.publishedBy).toBe(users.approver.id);
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'market_data.published'),
          eq(schema.outboxEvents.aggregateId, marketId),
        ),
      );
    expect(outbox.length).toBeGreaterThan(0);
    await expect(
      patchMarket(editor, marketId, {
        overlapNote: 'x',
        expectedVersion: published.version,
        changeReason: 'editor on published',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const detail = await getMarket(editor, marketId);
    expect(detail.publicationState).toBe('published');
  });

  it('merges a duplicate market, repointing references and archiving the source', async () => {
    const [ibadan] = await dbs.owner
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.slug, 'ng-ibadan'));
    const dup = await createMarket(editor, {
      slug: 'ng-ibadan-dup',
      name: 'Ibadan (duplicate)',
      aliases: ['Ibadan City'],
      stateId,
      geopoliticalZone: 'SW',
      displayOrder: 60,
      location: { lon: 3.9, lat: 7.38 },
      serviceAvailability: 'pending_operations_confirmation',
    });
    const obs = await createObservation(editor, {
      sourceId,
      metric: 'sale_price_median',
      statistic: 'median',
      value: 45_000_000,
      unit: 'NGN',
      numericRepresentation: 'whole_naira_not_kobo',
      geographyLevel: 'city',
      geographyLabel: 'Ibadan',
      marketId: dup.id,
      propertyCohort: '3-bedroom flat',
      retrievedAt: '2026-09-20',
    });
    const task = await createResearchTask(editor, dup.id, {
      title: 'Collect comparables',
      category: 'comparables',
      priority: 2,
    });
    const result = await mergeMarket(editor, dup.id, {
      targetMarketId: ibadan!.id,
      expectedVersion: dup.version,
      reason: 'Duplicate of Ibadan',
    });
    expect(result.repointed['observationInterpretations']).toBe(1);
    expect(result.repointed['researchTasks']).toBe(1);
    const [source] = await dbs.owner
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, dup.id));
    expect(source!.publicationState).toBe('archived');
    expect(source!.mergedIntoMarketId).toBe(ibadan!.id);
    const [movedTask] = await dbs.owner
      .select()
      .from(schema.researchTasks)
      .where(eq(schema.researchTasks.id, task.id));
    expect(movedTask!.marketId).toBe(ibadan!.id);
    const current = await dbs.owner
      .select()
      .from(schema.observationInterpretations)
      .where(
        and(
          eq(schema.observationInterpretations.observationId, obs.id),
          eq(schema.observationInterpretations.isCurrent, true),
        ),
      );
    expect(current[0]!.version).toBe(2);
    expect(current[0]!.appliesToMarketId).toBe(ibadan!.id);
    // The immutable observation still records where it was originally captured.
    const [raw] = await dbs.owner
      .select()
      .from(schema.observations)
      .where(eq(schema.observations.id, obs.id));
    expect(raw!.marketId).toBe(dup.id);
    const [target] = await dbs.owner
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, ibadan!.id));
    expect(target!.aliases).toContain('Ibadan City');
    const count = await dbs.owner.execute<{ n: string }>(
      sql`select count(*)::text as n from markets`,
    );
    expect(count.rows[0]?.n).toBe('52');
  });

  it('archives and restores instead of deleting, keeping the id and linked records', async () => {
    const detail = await getMarket(editor, marketId);
    await expect(
      transitionMarket(editor, marketId, 'archive', {
        expectedVersion: detail.version,
        reason: 'editor on published',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const archived = await transitionMarket(approver, marketId, 'archive', {
      expectedVersion: detail.version,
      reason: 'Superseded',
    });
    expect(archived.publicationState).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
    await expect(
      transitionMarket(editor, marketId, 'publish', {
        expectedVersion: archived.version,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const restored = await transitionMarket(editor, marketId, 'restore', {
      expectedVersion: archived.version,
      reason: 'Back in scope',
    });
    expect(restored.publicationState).toBe('draft');
    expect(restored.id).toBe(marketId);
    expect((await listRevisions(editor, marketId)).length).toBeGreaterThanOrEqual(5);
  });
});
