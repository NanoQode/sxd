import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { importMarketSeed, seedReferenceData } from '@simplexd/db/seed';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import { applyImport, previewImport } from './imports';
import {
  activateRankingPolicy,
  createRankingPolicyDraft,
  listRankingPolicies,
  patchDataPolicy,
  patchRankingPolicyDraft,
} from './policies';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.resolve(here, '../../../../../../data/seed/nigeria-50-markets.seed.json');

let dbs: TestDatabases;
let raw: { markets: Array<{ id: string; selection_basis?: string | null }> };
let approver: AdminContext;

const approverUser = {
  id: 'user_approver_im',
  name: 'Ada Approver',
  email: 'approver-im@example.test',
};

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedReferenceData(dbs.owner);
  raw = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  await importMarketSeed(dbs.owner, raw);
  await insertStaffUser(dbs.owner, approverUser, ['data_approver']);
  approver = contextFor(dbs.app, identityFor(approverUser, ['data_approver']));
});

afterAll(async () => {
  await dbs.close();
});

describe('imports', () => {
  it('previews a changed seed, reports the human-edited market as a conflict and writes nothing', async () => {
    await dbs.owner
      .update(schema.markets)
      .set({ profileMarkdown: 'Operator note', humanEditedAt: new Date() })
      .where(eq(schema.markets.slug, 'ng-abuja'));
    const changed = structuredClone(raw);
    changed.markets.find((m) => m.id === 'ng-abuja')!.selection_basis = 'Changed in a newer seed';
    const preview = await previewImport(approver, {
      fileName: 'seed-v2.json',
      format: 'seed_json',
      content: JSON.stringify(changed),
    });
    expect(preview.status).toBe('previewed');
    expect(preview.conflicts).toEqual([
      expect.objectContaining({ entity: 'market', id: 'ng-abuja' }),
    ]);
    expect(preview.summary).not.toHaveProperty('payload');
    const [abuja] = await dbs.owner
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.slug, 'ng-abuja'));
    expect(abuja!.selectionBasis).not.toBe('Changed in a newer seed');
    expect(abuja!.profileMarkdown).toBe('Operator note');
    const applied = await applyImport(approver, preview.id, { reason: 'Refresh seed' });
    expect(applied.status).toBe('applied');
    expect(applied.conflicts).toEqual([expect.objectContaining({ id: 'ng-abuja' })]);
    const [after] = await dbs.owner
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.slug, 'ng-abuja'));
    expect(after!.profileMarkdown).toBe('Operator note');
  });

  it('previews an observations CSV with row-level errors and applies only valid rows', async () => {
    const csv = [
      'slug,sourceSlug,marketSlug,metric,statistic,value,unit,numericRepresentation,geographyLevel,geographyLabel,propertyCohort,retrievedAt,sampleSize',
      'csv-ibadan-rent-1,npc-q3-2026,ng-ibadan,annual_rent_median,median,2500000,NGN/year,whole_naira_not_kobo,city,Ibadan,3-bedroom flat,2026-09-21,12',
      'csv-bad-row,unknown-source,ng-ibadan,annual_rent_median,median,notanumber,NGN/year,whole_naira_not_kobo,city,Ibadan,3-bedroom flat,2026-09-21,',
    ].join('\n');
    const preview = await previewImport(approver, {
      fileName: 'obs.csv',
      format: 'observations_csv',
      content: csv,
    });
    expect(preview.summary).toMatchObject({ rows: 2, valid: 1, invalid: 1 });
    expect(preview.rowErrors.some((e) => e.row === 3 && e.path === 'sourceSlug')).toBe(true);
    const applied = await applyImport(approver, preview.id);
    expect(applied.summary['applied']).toMatchObject({ created: 1 });
    const rows = await dbs.owner
      .select()
      .from(schema.observations)
      .where(eq(schema.observations.slug, 'csv-ibadan-rent-1'));
    expect(rows).toHaveLength(1);
    // Re-applying the same file skips the existing slug.
    const again = await previewImport(approver, {
      fileName: 'obs.csv',
      format: 'observations_csv',
      content: csv,
    });
    const appliedAgain = await applyImport(approver, again.id);
    expect(appliedAgain.summary['applied']).toMatchObject({ created: 0, skippedExisting: 1 });
  });
});

describe('ranking policies', () => {
  it('creates a draft, rejects activation with equal bounds and activates once fixed', async () => {
    const draft = await createRankingPolicyDraft(approver, { name: 'Proposed v2' });
    expect(draft.status).toBe('draft');
    expect(draft.version).toBe(2);
    const broken = await patchRankingPolicyDraft(approver, draft.version, {
      metricBounds: draft.metricBounds.map((b) =>
        b.metric === 'affordability' ? { ...b, low: 500_000, high: 500_000 } : b,
      ),
      reason: 'testing equal bounds',
    });
    expect(
      broken.errors.some((e) => e.metric === 'affordability' && /must exceed/.test(e.message)),
    ).toBe(true);
    await expect(
      activateRankingPolicy(approver, draft.version, { reason: 'go live' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const fixed = await patchRankingPolicyDraft(approver, draft.version, {
      metricBounds: draft.metricBounds,
      reason: 'restore bounds',
    });
    expect(fixed.errors).toEqual([]);
    const active = await activateRankingPolicy(approver, draft.version, {
      reason: 'Reviewed anchors',
    });
    expect(active.status).toBe('active');
    const all = await listRankingPolicies(approver);
    expect(all.find((p) => p.version === 1)?.status).toBe('retired');
    expect(all.filter((p) => p.status === 'active')).toHaveLength(1);
  });

  it('validates data policy values by type', async () => {
    await expect(
      patchDataPolicy(approver, 'publication.min_comparables', {
        value: 'ten',
        reason: 'bad type',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const updated = await patchDataPolicy(approver, 'publication.min_comparables', {
      value: 12,
      reason: 'Raise the bar',
    });
    expect(updated.value).toBe(12);
  });
});
