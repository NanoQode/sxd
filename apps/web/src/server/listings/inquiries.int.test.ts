import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { approveListing } from './moderation';
import { createListing, submitListing } from './owner';
import {
  contentIdentity,
  createListingFixture,
  insertListingProperty,
  insertVerifiedAuthority,
  ownerIdentity,
  type ListingFixture,
} from './testing/fixtures';

vi.mock('@/lib/auth/session', () => ({
  getIdentity: async () => ({
    session: null,
    actor: {
      userId: null,
      staffRoles: [],
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags: {},
    },
    ctx: { userId: null, organizationId: null, staff: false, anonymousToken: null },
    profile: null,
    featureFlags: {},
  }),
}));

const { POST } = await import('@/app/api/v1/public/listings/[slug]/inquiries/route');

let f: ListingFixture;
let slug: string;
let listingId: string;
let draftSlug: string;

function request(target: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost:3000/api/v1/public/listings/${target}/inquiries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'user-agent': 'vitest' },
    body: JSON.stringify(body),
  });
}

const call = (target: string, body: unknown, ip: string) =>
  POST(request(target, body, ip), { params: Promise.resolve({ slug: target }) });

beforeAll(async () => {
  f = await createListingFixture();
  const owner = ownerIdentity(f, 'A');
  const propertyId = await insertListingProperty(f.dbs.owner, f);
  await insertVerifiedAuthority(f.dbs.owner, f, propertyId);
  const draft = await createListing(owner, {
    propertyId,
    kind: 'sale',
    title: `Inquiry plot ${f.s}`,
    availability: 'now',
    mediaFileIds: [],
    publicLocationPrecision: 'market',
  });
  const submitted = await submitListing(owner, draft.id, { expectedVersion: draft.version });
  const published = await approveListing(contentIdentity(f), draft.id, {
    expectedVersion: submitted.version,
    revisionVersion: 1,
    approveExactLocation: false,
  });
  slug = published.slug;
  listingId = published.id;
  const other = await createListing(owner, {
    propertyId,
    kind: 'sale',
    title: `Unpublished plot ${f.s}`,
    availability: 'now',
    mediaFileIds: [],
    publicLocationPrecision: 'market',
  });
  draftSlug = other.slug;
});

afterAll(async () => {
  await closeDb();
  await f.cleanup();
});

const base = {
  contactName: 'Ngozi Okafor',
  email: 'ngozi@example.test',
  phoneE164: '+2348012345678',
  interest: 'buy',
  message: 'Is the plot still available and can I view it next week?',
  marketingConsent: false,
  elapsedMs: 9000,
};

describe('POST /api/v1/public/listings/:slug/inquiries', () => {
  it('creates a lead carrying the listing reference and tells the visitor only a reference', async () => {
    const res = await call(slug, base, `203.0.113.${(Date.now() % 200) + 10}`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('received');
    const [lead] = await f.dbs.owner
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, body.id));
    expect(lead).toBeDefined();
    expect(lead!.status).toBe('new');
    expect(lead!.source).toBe('website_form');
    const [service] = await f.dbs.owner
      .select({ template: schema.services.workflowTemplateKey })
      .from(schema.services)
      .where(eq(schema.services.id, lead!.interestServiceId!));
    expect(service?.template).toBe('land_sales_leasing');
    expect(lead!.context).toMatchObject({
      kind: 'listing_inquiry',
      listingId,
      listingSlug: slug,
      listingTitle: `Inquiry plot ${f.s}`,
      interest: 'buy',
      suspicious: false,
    });
    expect(lead!.ipHash).toHaveLength(24);
    const events = await f.dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, listingId));
    expect(events.some((e) => e.eventType === 'listing.inquiry_received')).toBe(true);
    await f.dbs.owner.delete(schema.leads).where(eq(schema.leads.id, body.id));
  });

  it('marks honeypot submissions for review and never notifies the owner about them', async () => {
    const res = await call(
      slug,
      { ...base, email: 'bot@example.test', website: 'http://spam.example' },
      '203.0.113.240',
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const [lead] = await f.dbs.owner
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, body.id));
    expect(lead!.status).toBe('spam');
    await f.dbs.owner.delete(schema.leads).where(eq(schema.leads.id, body.id));
  });

  it('refuses inquiries on listings that are not live and invalid payloads', async () => {
    expect((await call(draftSlug, base, '203.0.113.241')).status).toBe(404);
    expect((await call(`missing-${f.s}`, base, '203.0.113.241')).status).toBe(404);
    const res = await call(slug, { ...base, email: 'nope', message: 'hi' }, '203.0.113.242');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: Array<{ path: string }> };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.map((d) => d.path)).toEqual(
      expect.arrayContaining(['email', 'message']),
    );
  });

  it('rate limits one address to five inquiries per hour', async () => {
    const ip = `198.51.100.${(Date.now() % 200) + 10}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await call(slug, { ...base, email: `visitor${i}-${f.s}@example.test` }, ip);
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { id: string }).id);
    }
    const blocked = await call(slug, { ...base, email: `visitor6-${f.s}@example.test` }, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    for (const id of ids) await f.dbs.owner.delete(schema.leads).where(eq(schema.leads.id, id));
  });
});
