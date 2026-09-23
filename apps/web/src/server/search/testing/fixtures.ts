import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { schema, type Database } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import type { StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { identityFor } from '@/server/assignments/testing/fixtures';

export { errorCode, identityFor } from '@/server/assignments/testing/fixtures';

/**
 * Integration fixtures for property search and purchase representation. The
 * test database is shared with other suites running at the same time, so
 * nothing is truncated: every row carries a unique suffix and
 * `cleanupSearchFixture` removes what the fixture created (best effort).
 *
 * People: buyer organisation A (owner + approver), buyer organisation B
 * (owner), a seller organisation that owns the published listings, an
 * operations manager, a second operations manager (report reviewer), the
 * project manager assigned to A's requests and a project manager assigned to
 * nothing of A's. Requests: A's property search, purchase representation and
 * due diligence; B's property search.
 */

export interface SearchFixture {
  dbs: TestDatabases;
  suffix: string;
  orgA: string;
  orgB: string;
  sellerOrg: string;
  ownerA: string;
  approverA: string;
  ownerB: string;
  seller: string;
  ops: string;
  reviewer: string;
  pm: string;
  otherPm: string;
  searchServiceId: string;
  purchaseServiceId: string;
  diligenceServiceId: string;
  searchA: string;
  purchaseA: string;
  diligenceA: string;
  searchB: string;
  stateId: string;
  marketId: string;
  otherMarketId: string;
  userIds: string[];
  listingIds: string[];
  propertyIds: string[];
  fileIds: string[];
}

export interface ListingSpec {
  title: string;
  kind?: 'sale' | 'lease' | 'short_stay';
  propertyKind?: 'land' | 'residential' | 'commercial';
  priceKobo?: bigint | null;
  areaM2?: string | null;
  tenure?: string | null;
  titleDisclosure?: string | null;
  marketId?: string;
  checks?: Array<{ item: string; outcome?: string; expiresAt?: string }>;
  publishedAt?: Date;
  status?: 'published' | 'in_moderation' | 'paused' | 'withdrawn';
}

export async function createSearchFixture(): Promise<SearchFixture> {
  const dbs = connectTestDatabases();
  const o = dbs.owner;
  const s = uniqueSuffix();
  const ids = {
    orgA: `srch_org_a_${s}`,
    orgB: `srch_org_b_${s}`,
    sellerOrg: `srch_org_seller_${s}`,
    ownerA: `srch_owner_a_${s}`,
    approverA: `srch_approver_a_${s}`,
    ownerB: `srch_owner_b_${s}`,
    seller: `srch_seller_${s}`,
    ops: `srch_ops_${s}`,
    reviewer: `srch_reviewer_${s}`,
    pm: `srch_pm_${s}`,
    otherPm: `srch_pm2_${s}`,
  };
  const userIds = Object.entries(ids)
    .filter(([k]) => !k.startsWith('org') && k !== 'sellerOrg')
    .map(([, id]) => id);
  await o
    .insert(schema.user)
    .values(userIds.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
  await o.insert(schema.organization).values([
    { id: ids.orgA, name: `Buyer A ${s}`, slug: ids.orgA },
    { id: ids.orgB, name: `Buyer B ${s}`, slug: ids.orgB },
    { id: ids.sellerOrg, name: `Seller ${s}`, slug: ids.sellerOrg },
  ]);
  await o.insert(schema.member).values([
    { id: `m_${ids.ownerA}`, organizationId: ids.orgA, userId: ids.ownerA, role: 'owner' },
    { id: `m_${ids.approverA}`, organizationId: ids.orgA, userId: ids.approverA, role: 'approver' },
    { id: `m_${ids.ownerB}`, organizationId: ids.orgB, userId: ids.ownerB, role: 'owner' },
    { id: `m_${ids.seller}`, organizationId: ids.sellerOrg, userId: ids.seller, role: 'owner' },
  ]);
  await o.insert(schema.staffRoles).values([
    { userId: ids.ops, role: 'operations_manager' },
    { userId: ids.reviewer, role: 'operations_manager' },
    { userId: ids.pm, role: 'project_manager' },
    { userId: ids.otherPm, role: 'project_manager' },
  ]);
  const services = await o
    .insert(schema.services)
    .values([
      {
        slug: `property-search-${s}`,
        name: 'Property search',
        shortDescription: 'test',
        workflowTemplateKey: 'property_search',
        publicationState: 'published',
      },
      {
        slug: `purchase-support-${s}`,
        name: 'Purchase representation',
        shortDescription: 'test',
        workflowTemplateKey: 'purchase_support',
        publicationState: 'published',
      },
      {
        slug: `due-diligence-${s}`,
        name: 'Due diligence',
        shortDescription: 'test',
        workflowTemplateKey: 'due_diligence',
        publicationState: 'published',
      },
    ])
    .returning({ id: schema.services.id, key: schema.services.workflowTemplateKey });
  const searchServiceId = services.find((x) => x.key === 'property_search')!.id;
  const purchaseServiceId = services.find((x) => x.key === 'purchase_support')!.id;
  const diligenceServiceId = services.find((x) => x.key === 'due_diligence')!.id;
  await o.insert(schema.servicePackages).values([
    {
      serviceId: purchaseServiceId,
      slug: 'percentage',
      name: 'Purchase representation',
      priceBasis: 'percentage',
      percentageBps: 150,
      publicationState: 'published',
    },
    {
      serviceId: searchServiceId,
      slug: 'standard',
      name: 'Search engagement',
      priceBasis: 'from',
      amountKobo: 8_000_000n,
      publicationState: 'published',
    },
  ]);
  await o
    .insert(schema.countries)
    .values({ code: 'NG', name: 'Nigeria' })
    .onConflictDoNothing({ target: schema.countries.code });
  const [state] = await o
    .insert(schema.states)
    .values({ countryCode: 'NG', name: `Test State ${s}`, code: `TS${s.slice(-4)}`, geopoliticalZone: 'SW' })
    .returning({ id: schema.states.id });
  const markets = await o
    .insert(schema.markets)
    .values([
      {
        slug: `market-a-${s}`,
        name: `Market A ${s}`,
        countryCode: 'NG',
        stateId: state!.id,
        geopoliticalZone: 'SW',
        location: { lon: 3.4, lat: 6.5 },
        publicationState: 'published',
      },
      {
        slug: `market-b-${s}`,
        name: `Market B ${s}`,
        countryCode: 'NG',
        stateId: state!.id,
        geopoliticalZone: 'SW',
        location: { lon: 3.9, lat: 7.4 },
        publicationState: 'published',
      },
    ])
    .returning({ id: schema.markets.id, slug: schema.markets.slug });
  const marketId = markets.find((m) => m.slug === `market-a-${s}`)!.id;
  const otherMarketId = markets.find((m) => m.slug === `market-b-${s}`)!.id;
  const srs = await o
    .insert(schema.serviceRequests)
    .values([
      {
        reference: `SR-SRCH-A-${s}`,
        organizationId: ids.orgA,
        requestedByUserId: ids.ownerA,
        serviceId: searchServiceId,
        title: 'Three-bedroom in Lekki',
        status: 'in_progress',
        assignedPmUserId: ids.pm,
      },
      {
        reference: `SR-PUR-A-${s}`,
        organizationId: ids.orgA,
        requestedByUserId: ids.ownerA,
        serviceId: purchaseServiceId,
        title: 'Represent me on Plot 5',
        status: 'in_progress',
        assignedPmUserId: ids.pm,
      },
      {
        reference: `SR-DD-A-${s}`,
        organizationId: ids.orgA,
        requestedByUserId: ids.ownerA,
        serviceId: diligenceServiceId,
        title: 'Diligence on Plot 5',
        status: 'in_progress',
        assignedPmUserId: ids.pm,
      },
      {
        reference: `SR-SRCH-B-${s}`,
        organizationId: ids.orgB,
        requestedByUserId: ids.ownerB,
        serviceId: searchServiceId,
        title: 'Warehouse near the port',
        status: 'in_progress',
        assignedPmUserId: ids.otherPm,
      },
    ])
    .returning({ id: schema.serviceRequests.id, reference: schema.serviceRequests.reference });
  const byRef = (ref: string) => srs.find((r) => r.reference === ref)!.id;
  return {
    dbs,
    suffix: s,
    ...ids,
    searchServiceId,
    purchaseServiceId,
    diligenceServiceId,
    searchA: byRef(`SR-SRCH-A-${s}`),
    purchaseA: byRef(`SR-PUR-A-${s}`),
    diligenceA: byRef(`SR-DD-A-${s}`),
    searchB: byRef(`SR-SRCH-B-${s}`),
    stateId: state!.id,
    marketId,
    otherMarketId,
    userIds,
    listingIds: [],
    propertyIds: [],
    fileIds: [],
  };
}

/** A published listing of the seller organisation with the given disclosures. */
export async function insertListing(f: SearchFixture, spec: ListingSpec): Promise<string> {
  const o = f.dbs.owner;
  const [property] = await o
    .insert(schema.properties)
    .values({
      organizationId: f.sellerOrg,
      name: spec.title,
      kind: spec.propertyKind ?? 'residential',
      marketId: spec.marketId ?? f.marketId,
      createdBy: f.seller,
    })
    .returning({ id: schema.properties.id });
  f.propertyIds.push(property!.id);
  const status = spec.status ?? 'published';
  const [listing] = await o
    .insert(schema.listings)
    .values({
      organizationId: f.sellerOrg,
      propertyId: property!.id,
      kind: spec.kind ?? 'sale',
      status,
      slug: `listing-${uniqueSuffix()}-${randomUUID().slice(0, 8)}`,
      currentVersion: 1,
      publishedVersion: status === 'withdrawn' ? null : 1,
      publishedAt: spec.publishedAt ?? new Date(),
      publishedBy: f.ops,
      createdBy: f.seller,
    })
    .returning({ id: schema.listings.id });
  await o.insert(schema.listingRevisions).values({
    listingId: listing!.id,
    version: 1,
    title: spec.title,
    priceKobo: spec.priceKobo === undefined ? 50_000_000_00n : spec.priceKobo,
    priceBasis: 'asking',
    areaM2: spec.areaM2 === undefined ? '600.00' : spec.areaM2,
    tenure: spec.tenure === undefined ? 'freehold' : spec.tenure,
    titleDisclosure: spec.titleDisclosure === undefined ? 'C of O sighted' : spec.titleDisclosure,
    availability: 'now',
    verificationScope: {
      checks: (spec.checks ?? []).map((c) => ({
        item: c.item,
        checkedBy: 'SimplexD staff',
        checkedAt: new Date().toISOString(),
        result: 'recorded',
        outcome: c.outcome ?? 'passed',
        ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
      })),
      summary: (spec.checks ?? []).length > 0 ? 'Checks recorded by staff' : undefined,
    },
    publicLocationPrecision: 'market',
    createdBy: f.seller,
  });
  f.listingIds.push(listing!.id);
  return listing!.id;
}

/** A clean, scanned file row attached to a request (owner role). */
export async function insertCleanFile(
  f: SearchFixture,
  input: { ownerUserId: string; organizationId: string | null; entityId: string; name?: string; purpose?: string },
): Promise<string> {
  const content = `${input.name ?? 'file'}-${randomUUID()}`;
  const [row] = await f.dbs.owner
    .insert(schema.fileObjects)
    .values({
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      bucket: 'private',
      storageKey: `test/search/${uniqueSuffix()}-${randomUUID()}`,
      originalName: input.name ?? 'document.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: content.length,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
      status: 'clean',
      purpose: input.purpose ?? 'org_document',
      entityType: 'service_request',
      entityId: input.entityId,
    })
    .returning({ id: schema.fileObjects.id });
  f.fileIds.push(row!.id);
  return row!.id;
}

export function customerA(f: SearchFixture, who: 'owner' | 'approver' = 'owner'): RequestIdentity {
  return who === 'approver'
    ? identityFor(f.approverA, { memberships: [{ organizationId: f.orgA, role: 'approver' }] })
    : identityFor(f.ownerA, { memberships: [{ organizationId: f.orgA, role: 'owner' }] });
}

export function customerB(f: SearchFixture): RequestIdentity {
  return identityFor(f.ownerB, { memberships: [{ organizationId: f.orgB, role: 'owner' }] });
}

export function staff(userId: string, role: StaffRole): RequestIdentity {
  return identityFor(userId, { staffRoles: [role] });
}

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Best effort: rows another table still references are left in place.
  }
}

/** Removes what the fixture and the tests created (leaf tables first). */
export async function cleanupSearchFixture(f: SearchFixture): Promise<void> {
  const o = f.dbs.owner;
  const orgs = [f.orgA, f.orgB, f.sellerOrg];
  const srs = [f.searchA, f.purchaseA, f.diligenceA, f.searchB];
  const reports = (
    await o.select({ id: schema.reports.id }).from(schema.reports).where(inArray(schema.reports.organizationId, orgs))
  ).map((r) => r.id);
  await attempt(() => o.delete(schema.jobs).where(like(schema.jobs.dedupeKey, `saved-search-alert:%`)));
  await attempt(() =>
    o.delete(schema.notes).where(or(inArray(schema.notes.organizationId, orgs), inArray(schema.notes.entityId, srs))),
  );
  await attempt(() => o.delete(schema.engagementItems).where(inArray(schema.engagementItems.serviceRequestId, srs)));
  if (reports.length > 0) {
    await attempt(() => o.delete(schema.reportRevisions).where(inArray(schema.reportRevisions.reportId, reports)));
    await attempt(() => o.delete(schema.reports).where(inArray(schema.reports.id, reports)));
  }
  await attempt(() => o.delete(schema.offers).where(inArray(schema.offers.organizationId, orgs)));
  await attempt(() => o.delete(schema.viewings).where(inArray(schema.viewings.organizationId, orgs)));
  await attempt(() => o.delete(schema.shortlists).where(inArray(schema.shortlists.organizationId, orgs)));
  await attempt(() => o.delete(schema.savedSearches).where(inArray(schema.savedSearches.userId, f.userIds)));
  await attempt(() => o.delete(schema.appointments).where(inArray(schema.appointments.organizationId, orgs)));
  if (f.listingIds.length > 0) {
    await attempt(() => o.delete(schema.listingRevisions).where(inArray(schema.listingRevisions.listingId, f.listingIds)));
    await attempt(() => o.delete(schema.listings).where(inArray(schema.listings.id, f.listingIds)));
  }
  if (f.propertyIds.length > 0)
    await attempt(() => o.delete(schema.properties).where(inArray(schema.properties.id, f.propertyIds)));
  if (f.fileIds.length > 0) {
    await attempt(() => o.delete(schema.fileAccessGrants).where(inArray(schema.fileAccessGrants.fileId, f.fileIds)));
    await attempt(() => o.delete(schema.fileObjects).where(inArray(schema.fileObjects.id, f.fileIds)));
  }
  const quotes = (
    await o.select({ id: schema.quotes.id }).from(schema.quotes).where(inArray(schema.quotes.serviceRequestId, srs))
  ).map((q) => q.id);
  if (quotes.length > 0) {
    const versions = (
      await o.select({ id: schema.quoteVersions.id }).from(schema.quoteVersions).where(inArray(schema.quoteVersions.quoteId, quotes))
    ).map((v) => v.id);
    if (versions.length > 0) {
      await attempt(() => o.delete(schema.acceptances).where(inArray(schema.acceptances.quoteVersionId, versions)));
      await attempt(() => o.delete(schema.quoteVersions).where(inArray(schema.quoteVersions.id, versions)));
    }
    await attempt(() => o.delete(schema.quotes).where(inArray(schema.quotes.id, quotes)));
  }
  await attempt(() => o.delete(schema.engagementTransitions).where(inArray(schema.engagementTransitions.serviceRequestId, srs)));
  await attempt(() => o.delete(schema.assignments).where(inArray(schema.assignments.serviceRequestId, srs)));
  await attempt(() => o.delete(schema.outboxEvents).where(inArray(schema.outboxEvents.organizationId, orgs)));
  await attempt(() => o.delete(schema.auditEvents).where(inArray(schema.auditEvents.organizationId, orgs)));
  await attempt(() => o.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorUserId, f.userIds)));
  await attempt(() => o.delete(schema.serviceRequests).where(inArray(schema.serviceRequests.id, srs)));
  await attempt(() =>
    o.delete(schema.servicePackages).where(inArray(schema.servicePackages.serviceId, [f.searchServiceId, f.purchaseServiceId, f.diligenceServiceId])),
  );
  await attempt(() =>
    o.delete(schema.services).where(inArray(schema.services.id, [f.searchServiceId, f.purchaseServiceId, f.diligenceServiceId])),
  );
  await attempt(() => o.delete(schema.markets).where(inArray(schema.markets.id, [f.marketId, f.otherMarketId])));
  await attempt(() => o.delete(schema.states).where(eq(schema.states.id, f.stateId)));
  await attempt(() => o.delete(schema.staffRoles).where(inArray(schema.staffRoles.userId, f.userIds)));
  await attempt(() => o.delete(schema.member).where(inArray(schema.member.organizationId, orgs)));
  await attempt(() => o.delete(schema.organization).where(inArray(schema.organization.id, orgs)));
  await attempt(() => o.delete(schema.user).where(and(inArray(schema.user.id, f.userIds))));
  await f.dbs.close();
}

export type OwnerDb = Database;
