import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, type PriceAnchorValues } from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import { cacheDelete } from '@/lib/cache';
import { lagosToday } from '@/lib/services/price-anchors';
import { listServiceCatalog } from '@/server/services/catalog';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import {
  createPriceAnchor,
  getPriceAnchor,
  listPriceAnchors,
  retirePriceAnchor,
  savePriceAnchorDraft,
  transitionPriceAnchor,
} from './pricing';

/**
 * Price anchors: revisioned proposals, separation of duties on publication,
 * and the public catalogue contract (published values only, never a
 * proposal under review).
 */

let dbs: TestDatabases;
let sfx: string;
let managerA: AdminContext;
let managerB: AdminContext;
let managerBNoMfa: AdminContext;
let support: AdminContext;
let serviceId: string;
let serviceSlug: string;
let seededPackageId: string;

const values = (over: Partial<PriceAnchorValues> = {}): PriceAnchorValues => ({
  name: 'Monitoring engagement',
  description: null,
  scopeMarkdown: null,
  priceBasis: 'from',
  amountKobo: '15000000',
  percentageBps: null,
  currency: 'NGN',
  minimumScope: 'One project, scheduled site visits and reports as scoped.',
  exclusions: 'Contractor works and materials.',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  ...over,
});

async function catalog() {
  await cacheDelete('services:');
  const c = await listServiceCatalog();
  return { item: c.core.find((s) => s.slug === serviceSlug) ?? null, json: JSON.stringify(c) };
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  sfx = uniqueSuffix();
  const users = {
    a: { id: `pr_a_${sfx}`, name: 'Pricing A', email: `pr-a-${sfx}@example.test` },
    b: { id: `pr_b_${sfx}`, name: 'Pricing B', email: `pr-b-${sfx}@example.test` },
    s: { id: `pr_s_${sfx}`, name: 'Support', email: `pr-s-${sfx}@example.test` },
  };
  await insertStaffUser(dbs.owner, users.a, ['operations_manager']);
  await insertStaffUser(dbs.owner, users.b, ['operations_manager']);
  await insertStaffUser(dbs.owner, users.s, ['support']);
  managerA = contextFor(dbs.app, identityFor(users.a, ['operations_manager']));
  managerB = contextFor(dbs.app, identityFor(users.b, ['operations_manager']));
  managerBNoMfa = contextFor(dbs.app, identityFor(users.b, ['operations_manager'], { mfaVerified: false }));
  support = contextFor(dbs.app, identityFor(users.s, ['support']));
  serviceSlug = `pricing-test-${sfx}`;
  const [svc] = await dbs.owner
    .insert(schema.services)
    .values({
      slug: serviceSlug,
      name: `Pricing test service ${sfx}`,
      category: 'core',
      shortDescription: 'Pricing integration test',
      workflowTemplateKey: 'construction_monitoring',
      bookingEnabled: true,
      publicationState: 'published',
      sortOrder: 900,
    })
    .returning({ id: schema.services.id });
  serviceId = svc!.id;
  // Mirrors the reference seed: an in-review anchor with no revisions yet.
  const [seeded] = await dbs.owner
    .insert(schema.servicePackages)
    .values({
      serviceId,
      slug: 'seeded',
      name: 'Seeded package',
      priceBasis: 'fixed',
      amountKobo: 7_777_700n,
      minimumScope: 'UNREVIEWED-SCOPE-' + sfx,
      exclusions: 'UNREVIEWED-EXCLUSIONS-' + sfx,
      effectiveFrom: '2026-09-22',
      publicationState: 'in_review',
    })
    .returning({ id: schema.servicePackages.id });
  seededPackageId = seeded!.id;
});

async function quiet(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* append-only rows (revisions, audit) cannot be deleted; leave them */
  }
}

afterAll(async () => {
  await cacheDelete('services:');
  const pkgs = await dbs.owner
    .select({ id: schema.servicePackages.id })
    .from(schema.servicePackages)
    .where(eq(schema.servicePackages.serviceId, serviceId));
  for (const p of pkgs) {
    await quiet(() =>
      dbs.owner.delete(schema.servicePackageRevisions).where(eq(schema.servicePackageRevisions.packageId, p.id)),
    );
  }
  await quiet(() => dbs.owner.delete(schema.servicePackages).where(eq(schema.servicePackages.serviceId, serviceId)));
  await quiet(() => dbs.owner.delete(schema.services).where(eq(schema.services.id, serviceId)));
  // When history keeps the rows alive, archive the service so it never shows publicly.
  await quiet(() =>
    dbs.owner.update(schema.services).set({ publicationState: 'archived' }).where(eq(schema.services.id, serviceId)),
  );
  await cacheDelete('services:');
  await closeDb();
  await dbs.close();
});

describe('price anchors', () => {
  it('refuses readers and writers without pricing.manage', async () => {
    await expect(listPriceAnchors(support)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createPriceAnchor(support, { serviceId, slug: 'x', values: values() }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('drafts, submits and publishes through a different manager with MFA, keeping every revision', async () => {
    const created = await createPriceAnchor(managerA, {
      serviceId,
      slug: 'standard',
      values: values(),
      note: 'Homepage anchor',
    });
    expect(created.publicationState).toBe('draft');
    expect(created.latestRevision).toBe(1);
    expect(created.proposal?.state).toBe('draft');
    expect(created.proposal?.authors.map((u) => u.id)).toEqual([managerA.identity.actor.userId]);

    // Public: drafts are hidden entirely.
    let pub = await catalog();
    expect(pub.item?.packages.find((p) => p.slug === 'standard')).toBeUndefined();

    const submitted = await transitionPriceAnchor(managerA, created.id, {
      action: 'submit',
      expectedRevision: 1,
      reason: 'Ready for business review',
    });
    expect(submitted.proposal?.state).toBe('in_review');
    expect(submitted.latestRevision).toBe(2);

    // The author cannot publish or reject their own proposal.
    await expect(
      transitionPriceAnchor(managerA, created.id, { action: 'publish', expectedRevision: 2, reason: 'Approve' }),
    ).rejects.toMatchObject({ decision: { code: 'separation_of_duties' } });
    await expect(
      transitionPriceAnchor(managerA, created.id, { action: 'reject', expectedRevision: 2, reason: 'No' }),
    ).rejects.toMatchObject({ decision: { code: 'separation_of_duties' } });
    // A different manager needs a verified authenticator.
    await expect(
      transitionPriceAnchor(managerBNoMfa, created.id, { action: 'publish', expectedRevision: 2, reason: 'Approve' }),
    ).rejects.toMatchObject({ decision: { code: 'mfa_required' } });
    // A stale revision number is refused.
    await expect(
      transitionPriceAnchor(managerB, created.id, { action: 'publish', expectedRevision: 1, reason: 'Approve' }),
    ).rejects.toMatchObject({ code: 'version_conflict' });

    const published = await transitionPriceAnchor(managerB, created.id, {
      action: 'publish',
      expectedRevision: 2,
      reason: 'Reviewed against the homepage figures',
    });
    expect(published.publicationState).toBe('published');
    expect(published.live.amountKobo).toBe('15000000');
    expect(published.reviewedBy?.id).toBe(managerB.identity.actor.userId);
    expect(published.proposal).toBeNull();
    expect(published.latestRevision).toBe(3);
    expect(published.revisions?.map((r) => r.event)).toEqual(['published', 'submitted', 'draft_saved']);
    expect(published.version).toBe(created.version + 1);

    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, created.id))
      .orderBy(desc(schema.auditEvents.createdAt));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['price_anchor.created', 'price_anchor.submitted', 'price_anchor.published']),
    );
    expect(audit.find((a) => a.action === 'price_anchor.published')?.reason).toBe(
      'Reviewed against the homepage figures',
    );

    pub = await catalog();
    const shown = pub.item?.packages.find((p) => p.slug === 'standard');
    expect(shown?.priceLabel).toBe('From ₦150,000');
    expect(shown?.minimumScope).toBe(values().minimumScope);
  });

  it('never shows in-review values publicly: a pending change and a seeded anchor both stay hidden', async () => {
    const list = await listPriceAnchors(managerB);
    const standard = list.find((a) => a.serviceId === serviceId && a.slug === 'standard')!;
    const draft = await savePriceAnchorDraft(managerB, standard.id, {
      values: values({ amountKobo: '99999900', minimumScope: 'SECRET-SCOPE-' + sfx, exclusions: 'SECRET-EXCL-' + sfx }),
      expectedRevision: standard.latestRevision,
    });
    await transitionPriceAnchor(managerB, standard.id, {
      action: 'submit',
      expectedRevision: draft.latestRevision,
      reason: 'Price rise proposal',
    });

    const pub = await catalog();
    const shown = pub.item?.packages.find((p) => p.slug === 'standard');
    expect(shown?.priceLabel).toBe('From ₦150,000');
    expect(shown?.amountKobo).toBe('15000000');
    expect(pub.json).not.toContain('99999900');
    expect(pub.json).not.toContain('SECRET-SCOPE');
    expect(pub.json).not.toContain('SECRET-EXCL');

    const seeded = pub.item?.packages.find((p) => p.slug === 'seeded');
    expect(seeded?.publicationState).toBe('in_review');
    expect(seeded?.priceLabel).toBe('Indicative price under business review');
    expect(seeded?.amountKobo).toBeNull();
    expect(seeded?.minimumScope).toBeNull();
    expect(pub.json).not.toContain('7777700');
    expect(pub.json).not.toContain('UNREVIEWED-');

    // Withdraw so later tests start clean; the withdrawn revision stays on record.
    const after = await transitionPriceAnchor(managerA, standard.id, {
      action: 'withdraw',
      expectedRevision: draft.latestRevision + 1,
      reason: 'Not this quarter',
    });
    expect(after.proposal).toBeNull();
    expect(after.revisions?.[0]?.event).toBe('withdrawn');
  });

  it('treats a seeded in-review anchor as an implicit proposal: reject returns it to draft, publish makes it live', async () => {
    const detail = await getPriceAnchor(managerA, seededPackageId);
    expect(detail.proposal).toMatchObject({ state: 'in_review', implicit: true });
    expect(detail.latestRevision).toBe(0);
    await expect(
      transitionPriceAnchor(managerA, seededPackageId, { action: 'withdraw', expectedRevision: 0, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const rejected = await transitionPriceAnchor(managerA, seededPackageId, {
      action: 'reject',
      expectedRevision: 0,
      reason: 'Figure needs confirming',
    });
    expect(rejected.publicationState).toBe('draft');
    expect(rejected.proposal).toBeNull();
    expect((await catalog()).item?.packages.find((p) => p.slug === 'seeded')).toBeUndefined();

    const draft = await savePriceAnchorDraft(managerA, seededPackageId, {
      values: values({ name: 'Seeded package', priceBasis: 'fixed', amountKobo: '5000000' }),
      expectedRevision: 1,
    });
    await transitionPriceAnchor(managerA, seededPackageId, { action: 'submit', expectedRevision: draft.latestRevision, reason: 'ok' });
    const live = await transitionPriceAnchor(managerB, seededPackageId, {
      action: 'publish',
      expectedRevision: draft.latestRevision + 1,
      reason: 'Confirmed',
    });
    expect(live.publicationState).toBe('published');
    expect((await catalog()).item?.packages.find((p) => p.slug === 'seeded')?.priceLabel).toBe('₦50,000');
  });

  it('keeps the current anchor public until a future effective date, then retires with MFA and a reason', async () => {
    const list = await listPriceAnchors(managerA);
    const standard = list.find((a) => a.serviceId === serviceId && a.slug === 'standard')!;
    const tomorrow = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
    const draft = await savePriceAnchorDraft(managerA, standard.id, {
      values: values({ amountKobo: '18000000', effectiveFrom: tomorrow }),
      expectedRevision: standard.latestRevision,
    });
    await transitionPriceAnchor(managerA, standard.id, { action: 'submit', expectedRevision: draft.latestRevision, reason: 'Scheduled rise' });
    await transitionPriceAnchor(managerB, standard.id, { action: 'publish', expectedRevision: draft.latestRevision + 1, reason: 'Approved rise' });

    const pub = await catalog();
    const shown = pub.item?.packages.find((p) => p.slug === 'standard');
    expect(shown?.priceLabel).toBe('From ₦150,000');
    expect(shown?.upcomingEffectiveFrom).toBe(tomorrow);
    expect(pub.json).not.toContain('18000000');
    expect(lagosToday() < tomorrow).toBe(true);

    const current = await getPriceAnchor(managerB, standard.id);
    await expect(
      retirePriceAnchor(managerBNoMfa, standard.id, { expectedVersion: current.version, reason: 'Withdrawn from sale' }),
    ).rejects.toMatchObject({ decision: { code: 'mfa_required' } });
    await expect(
      retirePriceAnchor(managerB, standard.id, { expectedVersion: current.version - 1, reason: 'Withdrawn from sale' }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const retired = await retirePriceAnchor(managerB, standard.id, {
      expectedVersion: current.version,
      reason: 'Withdrawn from sale',
    });
    expect(retired.publicationState).toBe('retired');
    expect(retired.revisions?.[0]?.event).toBe('retired');
    expect((await catalog()).item?.packages.find((p) => p.slug === 'standard')).toBeUndefined();
  });

  it('validates the basis rules before anything is stored', async () => {
    await expect(
      createPriceAnchor(managerA, {
        serviceId,
        slug: 'bad',
        values: values({ priceBasis: 'percentage', amountKobo: '100', percentageBps: null }),
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      createPriceAnchor(managerA, { serviceId, slug: 'standard', values: values() }),
    ).rejects.toMatchObject({ code: 'conflict' } satisfies Partial<ApiError>);
  });
});
