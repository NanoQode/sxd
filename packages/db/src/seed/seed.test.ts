import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../schema';
import { withActor } from '../tenant';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '../testing';
import { importMarketSeed } from './markets';
import { seedReferenceData } from './reference';
import { validateSeed } from './schema';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.resolve(here, '../../../../data/seed/nigeria-50-markets.seed.json');

let dbs: TestDatabases;
let raw: unknown;

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  raw = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
});

afterAll(async () => {
  await dbs.close();
});

describe('seed validation', () => {
  it('accepts the shipped seed file', () => {
    const { issues } = validateSeed(raw);
    expect(issues).toEqual([]);
  });

  it('reports coordinates outside Nigeria and broken references', () => {
    const broken = structuredClone(raw) as {
      markets: Array<{
        geometry: { coordinates: [number, number] };
        supply_research_lead_ids: string[];
      }>;
    };
    broken.markets[0]!.geometry.coordinates = [6.45, 3.39]; // latitude, longitude swapped
    broken.markets[1]!.supply_research_lead_ids.push('nope');
    const { issues } = validateSeed(broken);
    expect(issues.some((i) => i.message.includes('outside Nigeria'))).toBe(true);
    expect(issues.some((i) => i.message.includes('unknown facility nope'))).toBe(true);
  });
});

describe('market import', () => {
  it('imports 50 markets, 16 observations and 13 facilities and is idempotent', async () => {
    await seedReferenceData(dbs.owner);
    const first = await importMarketSeed(dbs.owner, raw);
    expect(first.issues).toEqual([]);
    expect(first.markets.inserted).toBe(50);
    expect(first.observations.inserted).toBe(16);
    expect(first.facilities.inserted).toBe(13);
    expect(first.states.inserted).toBe(37);
    expect(first.conflicts).toEqual([]);

    const second = await importMarketSeed(dbs.owner, raw);
    expect(second.markets.inserted).toBe(0);
    expect(second.markets.unchanged).toBe(50);
    expect(second.observations.inserted).toBe(0);
    expect(second.observations.unchanged).toBe(16);
    expect(second.facilities.unchanged).toBe(13);
    expect(second.coverage.inserted).toBe(0);
    expect(second.researchTasks.inserted).toBe(0);

    const count = await dbs.owner.execute<{ n: string }>(
      sql`select count(*)::text as n from markets`,
    );
    expect(count.rows[0]?.n).toBe('50');
  });

  it('keeps every market as draft with null metrics and no rank-eligible evidence', async () => {
    const rows = await dbs.owner
      .select({
        publicationState: s.markets.publicationState,
        status: s.markets.recommendationStatus,
      })
      .from(s.markets);
    expect(rows.every((r) => r.publicationState === 'draft')).toBe(true);
    expect(rows.every((r) => r.status === 'insufficient_local_evidence')).toBe(true);
    const eligible = await dbs.owner
      .select()
      .from(s.observations)
      .where(eq(s.observations.rankEligible, true));
    expect(eligible).toHaveLength(0);
  });

  it('links Ibadan to city observations and Oyo statewide context, with parents for Ikeja and Ikorodu', async () => {
    const [ibadan] = await dbs.owner
      .select()
      .from(s.markets)
      .where(eq(s.markets.slug, 'ng-ibadan'));
    const obs = await dbs.owner
      .select({ slug: s.observations.slug, level: s.observations.geographyLevel })
      .from(s.observations)
      .where(eq(s.observations.marketId, ibadan!.id));
    expect(obs.map((o) => o.slug).sort()).toEqual(['npc-ibadan-rent', 'npc-ibadan-sale']);
    expect(obs.every((o) => o.level === 'city')).toBe(true);
    const oyo = await dbs.owner
      .select({ slug: s.observations.slug })
      .from(s.observations)
      .where(eq(s.observations.stateId, ibadan!.stateId));
    expect(oyo.map((o) => o.slug).sort()).toEqual(['npc-rent-oyo', 'npc-sale-oyo']);
    const [ikeja] = await dbs.owner.select().from(s.markets).where(eq(s.markets.slug, 'ng-ikeja'));
    const [lagos] = await dbs.owner.select().from(s.markets).where(eq(s.markets.slug, 'ng-lagos'));
    expect(ikeja!.parentMarketId).toBe(lagos!.id);
    expect(ikeja!.location).toEqual({ lon: 3.3426, lat: 6.6186 });
    const [sagamu] = await dbs.owner
      .select()
      .from(s.markets)
      .where(eq(s.markets.slug, 'ng-sagamu'));
    expect(sagamu!.aliases).toEqual(['Shagamu']);
  });

  it('does not overwrite human edits on re-import and reports a conflict instead', async () => {
    await dbs.owner
      .update(s.markets)
      .set({ profileMarkdown: 'Edited by an operator', humanEditedAt: new Date() })
      .where(eq(s.markets.slug, 'ng-abuja'));
    const changed = structuredClone(raw) as {
      markets: Array<{ id: string; selection_basis: string }>;
    };
    const abuja = changed.markets.find((m) => m.id === 'ng-abuja')!;
    abuja.selection_basis = 'Changed in a newer seed';
    const summary = await importMarketSeed(dbs.owner, changed);
    expect(summary.conflicts).toEqual([
      expect.objectContaining({ entity: 'market', id: 'ng-abuja' }),
    ]);
    const [row] = await dbs.owner.select().from(s.markets).where(eq(s.markets.slug, 'ng-abuja'));
    expect(row!.profileMarkdown).toBe('Edited by an operator');
    expect(row!.selectionBasis).not.toBe('Changed in a newer seed');
  });

  it('applies dry runs without persisting', async () => {
    await resetDatabase(dbs.owner);
    const summary = await importMarketSeed(dbs.owner, raw, { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.markets.inserted).toBe(50);
    const count = await dbs.owner.execute<{ n: string }>(
      sql`select count(*)::text as n from markets`,
    );
    expect(count.rows[0]?.n).toBe('0');
  });

  it('exposes draft markets to staff but hides them from anonymous readers only through publication state filters', async () => {
    await importMarketSeed(dbs.owner, raw);
    // Reference data is publicly readable at the database layer; the API filters by publication state.
    const anon = await withActor(
      dbs.app,
      { userId: null, organizationId: null, staff: false },
      (tx) => tx.select({ n: sql<string>`count(*)::text` }).from(s.markets),
    );
    expect(anon[0]?.n).toBe('50');
    // But anonymous actors cannot change markets.
    await withActor(dbs.app, { userId: null, organizationId: null, staff: false }, (tx) =>
      tx.update(s.markets).set({ publicationState: 'published' }),
    );
    const published = await dbs.owner.execute<{ n: string }>(
      sql`select count(*)::text as n from markets where publication_state = 'published'`,
    );
    expect(published.rows[0]?.n).toBe('0');
  });
});
