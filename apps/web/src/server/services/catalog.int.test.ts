import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { seedReferenceData } from '@simplexd/db/seed';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { cacheDelete } from '@/lib/cache';
import {
  getServiceBySlug,
  getServiceCoverageSummary,
  listServiceCatalog,
  toPublicServiceDto,
} from './catalog';

let dbs: TestDatabases;

async function clearCaches(): Promise<void> {
  await cacheDelete('services:');
  await cacheDelete('content:');
  await cacheDelete('content-kind:');
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedReferenceData(dbs.owner);
  await clearCaches();
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('listServiceCatalog', () => {
  it('lists the eight core services with in-review anchors and the planned expansion services', async () => {
    const catalog = await listServiceCatalog();
    expect(catalog.core.map((s) => s.slug)).toEqual([
      'construction-monitoring',
      'due-diligence',
      'architectural-services',
      'property-management',
      'virtual-inspections',
      'purchase-support',
      'property-search',
      'land-sales-leasing',
    ]);
    expect(catalog.planned).toHaveLength(23);
    for (const s of catalog.core) {
      expect(s.availability).toBe('request');
      expect(s.primaryPackage?.publicationState).toBe('in_review');
      expect(s.primaryPackage?.priceLabel).toBe('Indicative price under business review');
      expect(s.deliverables.length).toBeGreaterThan(0);
    }
    for (const s of catalog.planned) {
      expect(s.availability).toBe('inquiry_only');
      expect(s.featureFlagEnabled).toBe(false);
      expect(s.packages).toEqual([]);
    }
  });

  it('shows published anchors with their basis wording and keeps drafts hidden', async () => {
    const owner = dbs.owner;
    const publish = async (serviceSlug: string) => {
      const [svc] = await owner
        .select({ id: schema.services.id })
        .from(schema.services)
        .where(eq(schema.services.slug, serviceSlug));
      await owner
        .update(schema.servicePackages)
        .set({ publicationState: 'published', publishedAt: new Date() })
        .where(eq(schema.servicePackages.serviceId, svc!.id));
    };
    await publish('construction-monitoring');
    await publish('property-management');
    await publish('purchase-support');
    await publish('land-sales-leasing');
    // A draft package must never appear publicly.
    const [search] = await owner
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(eq(schema.services.slug, 'property-search'));
    await owner
      .update(schema.servicePackages)
      .set({ publicationState: 'draft' })
      .where(eq(schema.servicePackages.serviceId, search!.id));
    await clearCaches();

    const catalog = await listServiceCatalog();
    const label = (slug: string) =>
      catalog.core.find((s) => s.slug === slug)?.primaryPackage?.priceLabel ?? null;
    expect(label('construction-monitoring')).toBe('From ₦150,000');
    expect(label('property-management')).toBe('₦75,000 per month');
    expect(label('purchase-support')).toBe(
      '1.5% of purchase price (agreed basis and signed scope required)',
    );
    expect(label('land-sales-leasing')).toBe('By quotation');
    expect(label('due-diligence')).toBe('Indicative price under business review');
    expect(catalog.core.find((s) => s.slug === 'property-search')?.packages).toEqual([]);
  });

  it('applies a published CMS override for intro copy and long description', async () => {
    const owner = dbs.owner;
    const [page] = await owner
      .insert(schema.contentPages)
      .values({
        slug: 'due-diligence',
        kind: 'service',
        title: 'Due diligence',
        status: 'published',
        currentRevision: 1,
        publishedRevision: 1,
        publishedAt: new Date(),
      })
      .returning({ id: schema.contentPages.id });
    await owner.insert(schema.contentRevisions).values({
      pageId: page!.id,
      revision: 1,
      title: 'Due diligence',
      bodyMarkdown: '## What the memorandum covers\n\nScope and limitations.',
      fields: { intro: 'CMS intro for due diligence' },
      reviewStatus: 'approved',
    });
    await clearCaches();
    const service = await getServiceBySlug('due-diligence');
    expect(service?.shortDescription).toBe('CMS intro for due diligence');
    expect(service?.descriptionHtml).toContain('<h2>What the memorandum covers</h2>');
    expect(service?.cms?.kind).toBe('service');
  });

  it('opens a planned service for requests only when its flag is on and it is staffed', async () => {
    const owner = dbs.owner;
    await owner
      .update(schema.featureFlags)
      .set({ enabled: true })
      .where(eq(schema.featureFlags.key, 'expansion.diaspora_concierge'));
    await clearCaches();
    let service = await getServiceBySlug('diaspora-concierge');
    expect(service?.featureFlagEnabled).toBe(true);
    expect(service?.availability).toBe('inquiry_only');

    await owner
      .update(schema.services)
      .set({ staffed: true, bookingEnabled: true })
      .where(
        and(
          eq(schema.services.slug, 'diaspora-concierge'),
          eq(schema.services.category, 'expansion'),
        ),
      );
    await clearCaches();
    service = await getServiceBySlug('diaspora-concierge');
    expect(service?.availability).toBe('request');
  });

  it('exposes a public DTO without internal ids and reports coverage honestly when no market is published', async () => {
    const service = await getServiceBySlug('construction-monitoring');
    const dto = toPublicServiceDto(service!);
    expect(dto).toMatchObject({
      slug: 'construction-monitoring',
      category: 'core',
      bookable: true,
      href: '/services/construction-monitoring',
    });
    expect(dto).not.toHaveProperty('id');
    const coverage = await getServiceCoverageSummary(service!.id);
    expect(coverage).toEqual({
      available: 0,
      limited: 0,
      onRequest: 0,
      pending: 0,
      unavailable: 0,
      publishedMarkets: 0,
    });
  });
});
