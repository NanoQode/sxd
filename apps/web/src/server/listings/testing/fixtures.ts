import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '@/lib/auth/session';
import { identityFor, insertFile } from '@/server/assignments/testing/fixtures';

/**
 * Listing fixtures. Unlike the collaboration fixture this never truncates the
 * database: the test database is shared with other suites running at the
 * same time, so every row carries a unique suffix and `cleanup()` removes
 * exactly what was inserted (append-only audit and outbox rows are left in
 * place; they are keyed by these unique ids).
 *
 * Three customer organisations (A owns the property, B buys, C is unrelated),
 * an operations manager (rentals.manage: verifies authorities and records
 * checks), a content editor (content.publish: moderation decisions), a
 * support agent (neither), one state and market, the land sales/leasing
 * service (identified by its workflow template key) and one open land
 * request for organisation A.
 */
export interface ListingFixture {
  dbs: TestDatabases;
  s: string;
  orgA: string;
  orgB: string;
  orgC: string;
  ownerA: string;
  ownerB: string;
  ownerC: string;
  ops: string;
  content: string;
  support: string;
  stateId: string;
  stateName: string;
  marketId: string;
  marketSlug: string;
  landServiceId: string;
  landRequestA: string;
  cleanup: () => Promise<void>;
}

export async function createListingFixture(): Promise<ListingFixture> {
  const dbs = connectTestDatabases();
  const o = dbs.owner;
  const s = uniqueSuffix();
  const ids = {
    orgA: `lst_org_a_${s}`,
    orgB: `lst_org_b_${s}`,
    orgC: `lst_org_c_${s}`,
    ownerA: `lst_owner_a_${s}`,
    ownerB: `lst_owner_b_${s}`,
    ownerC: `lst_owner_c_${s}`,
    ops: `lst_ops_${s}`,
    content: `lst_content_${s}`,
    support: `lst_support_${s}`,
  };
  await o.insert(schema.user).values(
    Object.entries(ids)
      .filter(([k]) => !k.startsWith('org'))
      .map(([, id]) => ({ id, name: id, email: `${id}@example.test` })),
  );
  await o.insert(schema.organization).values([
    { id: ids.orgA, name: `Owner Org ${s}`, slug: ids.orgA },
    { id: ids.orgB, name: `Buyer Org ${s}`, slug: ids.orgB },
    { id: ids.orgC, name: `Other Org ${s}`, slug: ids.orgC },
  ]);
  await o.insert(schema.member).values([
    { id: `m_${ids.ownerA}`, organizationId: ids.orgA, userId: ids.ownerA, role: 'owner' },
    { id: `m_${ids.ownerB}`, organizationId: ids.orgB, userId: ids.ownerB, role: 'owner' },
    { id: `m_${ids.ownerC}`, organizationId: ids.orgC, userId: ids.ownerC, role: 'owner' },
  ]);
  await o.insert(schema.staffRoles).values([
    { userId: ids.ops, role: 'operations_manager' },
    { userId: ids.content, role: 'content_editor' },
    { userId: ids.support, role: 'support' },
  ]);
  await o
    .insert(schema.countries)
    .values({ code: 'NG', name: 'Nigeria' })
    .onConflictDoNothing({ target: schema.countries.code });
  const stateName = `Listing State ${s}`;
  const [state] = await o
    .insert(schema.states)
    .values({ countryCode: 'NG', name: stateName, code: `LS${s.slice(-4)}`, geopoliticalZone: 'SW' })
    .returning({ id: schema.states.id });
  const marketSlug = `listing-market-${s}`;
  const [market] = await o
    .insert(schema.markets)
    .values({
      slug: marketSlug,
      name: `Listing Market ${s}`,
      countryCode: 'NG',
      stateId: state!.id,
      geopoliticalZone: 'SW',
      location: { lon: 3.4, lat: 6.5 },
      publicationState: 'published',
    })
    .returning({ id: schema.markets.id });
  const [service] = await o
    .insert(schema.services)
    .values({
      slug: `land-sales-leasing-${s}`,
      name: 'Land sales and leasing (test)',
      shortDescription: 'test',
      workflowTemplateKey: 'land_sales_leasing',
    })
    .returning({ id: schema.services.id });
  const [sr] = await o
    .insert(schema.serviceRequests)
    .values({
      reference: `SR-LAND-${s}`,
      organizationId: ids.orgA,
      requestedByUserId: ids.ownerA,
      serviceId: service!.id,
      title: 'Sell the Epe plot',
      status: 'in_progress',
    })
    .returning({ id: schema.serviceRequests.id });

  const cleanup = async () => {
    const listingRows = await o
      .select({ id: schema.listings.id })
      .from(schema.listings)
      .where(eq(schema.listings.organizationId, ids.orgA));
    const listingIds = listingRows.map((r) => r.id);
    for (const id of listingIds) {
      await o.delete(schema.offers).where(eq(schema.offers.listingId, id));
      await o.delete(schema.engagementItems).where(eq(schema.engagementItems.subjectId, id));
      await o.delete(schema.listingRevisions).where(eq(schema.listingRevisions.listingId, id));
    }
    for (const org of [ids.orgA, ids.orgB, ids.orgC]) {
      await o.delete(schema.listings).where(eq(schema.listings.organizationId, org));
      await o.delete(schema.engagementItems).where(eq(schema.engagementItems.organizationId, org));
      await o.delete(schema.leads).where(eq(schema.leads.organizationId, org));
      await o.delete(schema.ownerAuthorities).where(eq(schema.ownerAuthorities.organizationId, org));
      await o
        .delete(schema.fileDownloadLog)
        .where(
          inArray(
            schema.fileDownloadLog.fileId,
            o
              .select({ id: schema.fileObjects.id })
              .from(schema.fileObjects)
              .where(eq(schema.fileObjects.organizationId, org)),
          ),
        );
      await o.delete(schema.fileObjects).where(eq(schema.fileObjects.organizationId, org));
      await o.delete(schema.properties).where(eq(schema.properties.organizationId, org));
      await o.delete(schema.serviceRequests).where(eq(schema.serviceRequests.organizationId, org));
    }
    await o.delete(schema.services).where(eq(schema.services.id, service!.id));
    await o.delete(schema.markets).where(eq(schema.markets.id, market!.id));
    await o.delete(schema.states).where(eq(schema.states.id, state!.id));
    for (const userId of [ids.ops, ids.content, ids.support]) {
      await o.delete(schema.staffRoles).where(eq(schema.staffRoles.userId, userId));
    }
    await dbs.close();
  };

  return {
    dbs,
    s,
    ...ids,
    stateId: state!.id,
    stateName,
    marketId: market!.id,
    marketSlug,
    landServiceId: service!.id,
    landRequestA: sr!.id,
    cleanup,
  };
}

export function ownerIdentity(f: ListingFixture, which: 'A' | 'B' | 'C'): RequestIdentity {
  const userId = which === 'A' ? f.ownerA : which === 'B' ? f.ownerB : f.ownerC;
  const organizationId = which === 'A' ? f.orgA : which === 'B' ? f.orgB : f.orgC;
  return identityFor(userId, { memberships: [{ organizationId, role: 'owner' }] });
}

export function opsIdentity(f: ListingFixture): RequestIdentity {
  return identityFor(f.ops, { staffRoles: ['operations_manager'] });
}

export function contentIdentity(f: ListingFixture): RequestIdentity {
  return identityFor(f.content, { staffRoles: ['content_editor'] });
}

export function supportIdentity(f: ListingFixture): RequestIdentity {
  return identityFor(f.support, { staffRoles: ['support'] });
}

/** A land property of organisation A on the fixture market, with coordinates. */
export async function insertListingProperty(
  owner: Database,
  f: ListingFixture,
  values: Partial<typeof schema.properties.$inferInsert> = {},
): Promise<string> {
  const [row] = await owner
    .insert(schema.properties)
    .values({
      organizationId: f.orgA,
      name: `Epe plot ${uniqueSuffix()}`,
      kind: 'land',
      marketId: f.marketId,
      location: { lon: 3.9876, lat: 6.5432 },
      ...values,
    })
    .returning({ id: schema.properties.id });
  return row!.id;
}

/** A verified owner authority for the property (owner role), optionally already lapsed. */
export async function insertVerifiedAuthority(
  owner: Database,
  f: ListingFixture,
  propertyId: string,
  opts: { expiresAt?: Date | null; status?: 'verified' | 'pending' | 'rejected' } = {},
): Promise<string> {
  const file = await insertFile(owner, f.orgA, f.ownerA);
  const status = opts.status ?? 'verified';
  const [row] = await owner
    .insert(schema.ownerAuthorities)
    .values({
      organizationId: f.orgA,
      propertyId,
      ownerName: 'Chief Adebayo',
      authorityDocumentFileId: file,
      status,
      verifiedBy: status === 'verified' ? f.ops : null,
      verifiedAt: status === 'verified' ? new Date(Date.now() - 60_000) : null,
      expiresAt: opts.expiresAt === undefined ? new Date(Date.now() + 30 * 86_400_000) : opts.expiresAt,
    })
    .returning({ id: schema.ownerAuthorities.id });
  return row!.id;
}

/** Matches an ApiError or AuthorizationError by code. */
export function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; name?: string };
  if (e?.name === 'AuthorizationError') return 'forbidden';
  return e?.code;
}
