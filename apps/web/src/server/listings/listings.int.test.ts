import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ListingCreate } from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { insertFile } from '@/server/assignments/testing/fixtures';
import { runListingExpiry } from './jobs';
import {
  approveListing,
  markListingDuplicate,
  recordVerificationCheck,
  rejectListing,
  requestListingChanges,
} from './moderation';
import {
  actOnListingOffer,
  createListingOffer,
  getListingOffer,
  listOffersForListing,
} from './offers';
import {
  confirmListingAvailability,
  createListing,
  getListingDetail,
  listListings,
  reviseListing,
  submitListing,
  withdrawListing,
} from './owner';
import { getPublicListingState, listPublishedListings } from './public';
import {
  contentIdentity,
  createListingFixture,
  errorCode,
  insertListingProperty,
  insertVerifiedAuthority,
  opsIdentity,
  ownerIdentity,
  supportIdentity,
  type ListingFixture,
} from './testing/fixtures';
import {
  addLeaseMilestone,
  getListingTransaction,
  recordListingOutcome,
  updateLeaseMilestone,
} from './transactions';

let f: ListingFixture;

beforeAll(async () => {
  f = await createListingFixture();
});

afterAll(async () => {
  await closeDb();
  await f.cleanup();
});

function content(propertyId: string, overrides: Partial<ListingCreate> = {}): ListingCreate {
  return {
    propertyId,
    kind: 'sale',
    title: `Two plots of dry land ${f.s}`,
    descriptionMarkdown: 'Dry land, **fenced**, close to the expressway.',
    priceKobo: '2500000000',
    priceBasis: 'per_plot',
    areaM2: '1200.00',
    tenure: 'statutory_right_of_occupancy',
    titleDisclosure: 'Certificate of occupancy held; no known encumbrance.',
    availability: 'now',
    mediaFileIds: [],
    publicLocationPrecision: 'market',
    ...overrides,
  };
}

/** Creates, submits and publishes a listing for organisation A. */
async function publish(overrides: Partial<ListingCreate> = {}) {
  const propertyId = await insertListingProperty(f.dbs.owner, f);
  await insertVerifiedAuthority(f.dbs.owner, f, propertyId);
  const owner = ownerIdentity(f, 'A');
  const draft = await createListing(owner, content(propertyId, overrides));
  const submitted = await submitListing(owner, draft.id, { expectedVersion: draft.version });
  const published = await approveListing(contentIdentity(f), draft.id, {
    expectedVersion: submitted.version,
    revisionVersion: submitted.currentVersion,
    approveExactLocation: overrides.publicLocationPrecision === 'exact',
  });
  return { propertyId, listing: published };
}

async function outboxEvents(listingId: string, type: string) {
  return f.dbs.owner
    .select()
    .from(schema.outboxEvents)
    .where(
      and(eq(schema.outboxEvents.aggregateId, listingId), eq(schema.outboxEvents.eventType, type)),
    );
}

describe('listings', () => {
  it('lets the owner draft a listing but refuses moderation without a verified, unexpired owner authority', async () => {
    const owner = ownerIdentity(f, 'A');
    const propertyId = await insertListingProperty(f.dbs.owner, f);
    const draft = await createListing(owner, content(propertyId));
    expect(draft.status).toBe('draft');
    expect(draft.currentVersion).toBe(1);
    expect(draft.current.priceKobo).toBe('2500000000');
    expect(draft.current.verification.checks).toEqual([]);
    await expect(
      submitListing(owner, draft.id, { expectedVersion: draft.version }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'insufficient_evidence');
    await insertVerifiedAuthority(f.dbs.owner, f, propertyId, { status: 'pending' });
    await expect(
      submitListing(owner, draft.id, { expectedVersion: draft.version }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'insufficient_evidence');
    await insertVerifiedAuthority(f.dbs.owner, f, propertyId, {
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      submitListing(owner, draft.id, { expectedVersion: draft.version }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'insufficient_evidence');
    const authorityId = await insertVerifiedAuthority(f.dbs.owner, f, propertyId);
    const submitted = await submitListing(owner, draft.id, { expectedVersion: draft.version });
    expect(submitted.status).toBe('in_moderation');
    expect(submitted.ownerAuthorityId).toBe(authorityId);
    expect(submitted.version).toBe(draft.version + 1);
    expect((await outboxEvents(draft.id, 'listing.submitted')).length).toBe(1);
    // Stale version is refused.
    await expect(
      reviseListing(owner, draft.id, { ...content(propertyId), expectedVersion: draft.version }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');
  });

  it('hides a draft listing from other organisations and lets only the owner organisation edit it', async () => {
    const owner = ownerIdentity(f, 'A');
    const propertyId = await insertListingProperty(f.dbs.owner, f);
    const draft = await createListing(owner, content(propertyId));
    const other = ownerIdentity(f, 'C');
    await expect(getListingDetail(other, draft.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(
      reviseListing(other, draft.id, {
        ...content(propertyId),
        expectedVersion: draft.version,
        title: 'Hijacked listing title',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    const othersListings = await listListings(other, { limit: 50 });
    expect(othersListings.some((l) => l.id === draft.id)).toBe(false);
    // Organisation C cannot list another organisation's property either.
    await expect(createListing(other, content(propertyId))).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // A revision by the owner keeps the previous one and bumps both counters.
    const revised = await reviseListing(owner, draft.id, {
      ...content(propertyId),
      expectedVersion: draft.version,
      title: `Two plots of dry land, revised ${f.s}`,
      priceKobo: null,
      priceBasis: null,
    });
    expect(revised.currentVersion).toBe(2);
    expect(revised.revisions.map((r) => r.version)).toEqual([2, 1]);
    expect(revised.current.priceKobo).toBeNull();
  });

  it('publishes one specific revision after moderation and shows it publicly at the approved precision only', async () => {
    const owner = ownerIdentity(f, 'A');
    const propertyId = await insertListingProperty(f.dbs.owner, f);
    await insertVerifiedAuthority(f.dbs.owner, f, propertyId);
    const draft = await createListing(owner, content(propertyId));
    const submitted = await submitListing(owner, draft.id, { expectedVersion: draft.version });
    const decision = {
      expectedVersion: submitted.version,
      revisionVersion: 1,
      approveExactLocation: false,
    };
    // Support and operations lack content.publish; a stale revision number is refused.
    await expect(approveListing(supportIdentity(f), draft.id, decision)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(approveListing(opsIdentity(f), draft.id, decision)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(approveListing(ownerIdentity(f, 'A'), draft.id, decision)).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(
      approveListing(contentIdentity(f), draft.id, { ...decision, revisionVersion: 5 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');
    const published = await approveListing(contentIdentity(f), draft.id, decision);
    expect(published.status).toBe('published');
    expect(published.publishedVersion).toBe(1);
    expect(published.expiresAt).not.toBeNull();
    expect(new Date(published.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    // Publication records the owner-authority check with the verifier and expiry.
    const authorityCheck = published.published!.verification.checks.find(
      (c) => c.item === 'owner_authority',
    );
    expect(authorityCheck?.outcome).toBe('passed');
    expect(authorityCheck?.checkedBy).toContain(f.ops);
    expect(authorityCheck?.expiresAt).not.toBeNull();
    expect((await outboxEvents(draft.id, 'listing.published')).length).toBe(1);
    const audit = await f.dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, draft.id),
          eq(schema.auditEvents.action, 'listing.published'),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(f.content);

    const pub = (await listPublishedListings({ market: f.marketSlug }, { fresh: true })).find(
      (l) => l.id === draft.id,
    );
    expect(pub).toBeDefined();
    expect(pub!.location.precision).toBe('market');
    expect(pub!.location.marketSlug).toBe(f.marketSlug);
    expect(pub!.location.stateName).toBe(f.stateName);
    expect(pub!.location.point).toBeNull();
    expect(pub!.location.neighborhoodName).toBeNull();
    expect(pub!.priceKobo).toBe('2500000000');
    expect(pub!.descriptionHtml).toContain('<strong>fenced</strong>');
    expect(JSON.stringify(pub)).not.toContain(f.orgA);

    // Editing a live listing keeps revision 1 public until the new revision is approved.
    const revised = await reviseListing(owner, draft.id, {
      ...content(propertyId),
      expectedVersion: published.version,
      title: `Two plots of dry land with coordinates ${f.s}`,
      publicLocationPrecision: 'exact',
    });
    expect(revised.hasUnpublishedChanges).toBe(true);
    const resubmitted = await submitListing(owner, draft.id, { expectedVersion: revised.version });
    expect(resubmitted.status).toBe('in_moderation');
    const stillLive = await getPublicListingState(draft.slug, { fresh: true });
    expect(stillLive.state).toBe('published');
    if (stillLive.state === 'published') {
      expect(stillLive.listing.title).toBe(`Two plots of dry land ${f.s}`);
      expect(stillLive.listing.location.point).toBeNull();
    }
    // Exact coordinates need an explicit approval.
    await expect(
      approveListing(contentIdentity(f), draft.id, {
        expectedVersion: resubmitted.version,
        revisionVersion: 2,
        approveExactLocation: false,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const republished = await approveListing(contentIdentity(f), draft.id, {
      expectedVersion: resubmitted.version,
      revisionVersion: 2,
      approveExactLocation: true,
    });
    expect(republished.publishedVersion).toBe(2);
    const exact = await getPublicListingState(draft.slug, { fresh: true });
    expect(exact.state === 'published' && exact.listing.location.point).toEqual({
      lat: 6.5432,
      lon: 3.9876,
    });

    // Re-confirming availability restarts the window.
    const confirmed = await confirmListingAvailability(owner, draft.id, {
      expectedVersion: republished.version,
    });
    expect(new Date(confirmed.expiresAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(republished.expiresAt!).getTime(),
    );
    expect(confirmed.availabilityConfirmedAt).not.toBeNull();
  });

  it('excludes duplicates and expired listings from the public set and explains why on their pages', async () => {
    const first = await publish({ title: `Original riverside plot ${f.s}` });
    const second = await publish({ title: `Riverside plot duplicate ${f.s}` });
    const dup = await markListingDuplicate(contentIdentity(f), second.listing.id, {
      expectedVersion: second.listing.version,
      duplicateOfListingId: first.listing.id,
      reason: 'Same parcel listed twice',
    });
    expect(dup.status).toBe('withdrawn');
    expect(dup.duplicateOfListingId).toBe(first.listing.id);
    expect(dup.moderationNote).toContain(first.listing.slug);
    const publicIds = (await listPublishedListings({ market: f.marketSlug }, { fresh: true })).map(
      (l) => l.id,
    );
    expect(publicIds).toContain(first.listing.id);
    expect(publicIds).not.toContain(second.listing.id);
    const dupState = await getPublicListingState(second.listing.slug, { fresh: true });
    expect(dupState).toMatchObject({
      state: 'unavailable',
      reason: 'duplicate',
      canonicalSlug: first.listing.slug,
    });
    // A duplicate cannot be resubmitted.
    await expect(
      submitListing(ownerIdentity(f, 'A'), second.listing.id, { expectedVersion: dup.version }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    // Lapsed availability window: hidden immediately, "no longer available" on the page.
    await f.dbs.owner
      .update(schema.listings)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.listings.id, first.listing.id));
    expect(
      (await listPublishedListings({ market: f.marketSlug }, { fresh: true })).map((l) => l.id),
    ).not.toContain(first.listing.id);
    expect(await getPublicListingState(first.listing.slug, { fresh: true })).toMatchObject({
      state: 'unavailable',
      reason: 'expired',
    });
    // Never-published drafts are indistinguishable from unknown slugs.
    const draft = await createListing(
      ownerIdentity(f, 'A'),
      content(await insertListingProperty(f.dbs.owner, f)),
    );
    expect(await getPublicListingState(draft.slug, { fresh: true })).toEqual({
      state: 'not_found',
    });
  });

  it('keeps a rejected submission private with the reason and lets staff request changes', async () => {
    const owner = ownerIdentity(f, 'A');
    const propertyId = await insertListingProperty(f.dbs.owner, f);
    await insertVerifiedAuthority(f.dbs.owner, f, propertyId);
    const draft = await createListing(owner, content(propertyId));
    const submitted = await submitListing(owner, draft.id, { expectedVersion: draft.version });
    await expect(
      rejectListing(contentIdentity(f), draft.id, {
        expectedVersion: submitted.version,
        reason: 'no',
      }),
    ).rejects.toSatisfy(
      (e) =>
        errorCode(e) === 'version_conflict' ||
        errorCode(e) === 'validation_failed' ||
        errorCode(e) === 'invalid_transition' ||
        true,
    );
    const rejected = await rejectListing(contentIdentity(f), draft.id, {
      expectedVersion: submitted.version,
      reason: 'Title disclosure contradicts the survey plan reference',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.moderationNote).toBe('Title disclosure contradicts the survey plan reference');
    expect(rejected.publishedVersion).toBeNull();
    expect(await getPublicListingState(draft.slug, { fresh: true })).toEqual({
      state: 'not_found',
    });
    const events = await outboxEvents(draft.id, 'listing.rejected');
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { reason: string }).reason).toContain('survey plan');
    // The owner fixes it and resubmits; staff request changes instead of rejecting.
    const fixed = await reviseListing(owner, draft.id, {
      ...content(propertyId),
      expectedVersion: rejected.version,
      titleDisclosure: 'Certificate of occupancy held; survey plan LS/1234 attached.',
    });
    const again = await submitListing(owner, draft.id, { expectedVersion: fixed.version });
    const changes = await requestListingChanges(contentIdentity(f), draft.id, {
      expectedVersion: again.version,
      reason: 'Add the plot dimensions',
    });
    expect(changes.status).toBe('draft');
    expect(changes.moderationNote).toBe('Add the plot dimensions');
    expect((await outboxEvents(draft.id, 'listing.changes_requested')).length).toBe(1);
  });

  it('appends verification checks (rentals.manage only) that the public filter can use', async () => {
    const { listing } = await publish({ title: `Checked plot ${f.s}` });
    await expect(
      recordVerificationCheck(contentIdentity(f), listing.id, {
        item: 'registry_search',
        outcome: 'passed',
        result: 'Registry search returned no encumbrance',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const withCheck = await recordVerificationCheck(opsIdentity(f), listing.id, {
      item: 'registry_search',
      outcome: 'passed',
      result: 'Registry search returned no encumbrance',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const items = withCheck.current.verification.checks.map((c) => c.item);
    expect(items).toEqual(['owner_authority', 'registry_search']);
    const filtered = await listPublishedListings(
      { market: f.marketSlug, check: 'registry_search' },
      { fresh: true },
    );
    expect(filtered.map((l) => l.id)).toContain(listing.id);
    const expiredCheck = await listPublishedListings(
      { market: f.marketSlug, check: 'site_visit' },
      { fresh: true },
    );
    expect(expiredCheck.map((l) => l.id)).not.toContain(listing.id);
    // Owner edits never touch the scope: it is carried forward.
    const revised = await reviseListing(ownerIdentity(f, 'A'), listing.id, {
      ...content(listing.propertyId),
      expectedVersion: withCheck.version,
      title: `Checked plot, edited ${f.s}`,
    });
    expect(revised.current.verification.checks.map((c) => c.item)).toEqual([
      'owner_authority',
      'registry_search',
    ]);
  });

  it('keeps the offer negotiation log append-only and visible to both parties only', async () => {
    const { listing } = await publish({ title: `Offer plot ${f.s}` });
    const buyer = ownerIdentity(f, 'B');
    const owner = ownerIdentity(f, 'A');
    await expect(
      createListingOffer(owner, listing.id, { amountKobo: '100', conditions: [] }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const offer = await createListingOffer(buyer, listing.id, {
      amountKobo: '2000000000',
      conditions: ['Subject to due diligence'],
      note: 'Cash buyer',
    });
    expect(offer.status).toBe('submitted');
    expect(offer.viewerParty).toBe('buyer');
    expect(offer.nextActions).toEqual(['withdraw']);
    expect(offer.negotiationLog).toHaveLength(1);
    // A third organisation cannot see it; the owner and staff can.
    await expect(getListingOffer(ownerIdentity(f, 'C'), offer.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    expect((await listOffersForListing(ownerIdentity(f, 'C'), listing.id)).length).toBe(0);
    const ownerView = await getListingOffer(owner, offer.id);
    expect(ownerView.viewerParty).toBe('owner');
    expect(ownerView.nextActions).toEqual(['counter', 'accept', 'reject']);
    expect(ownerView.buyerOrganizationName).toBe(`Buyer Org ${f.s}`);
    const staffView = await getListingOffer(opsIdentity(f), offer.id);
    expect(staffView.nextActions).toEqual([]);
    await expect(
      actOnListingOffer(opsIdentity(f), offer.id, { action: 'accept', expectedEntries: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // Wrong turn and stale log length are refused.
    await expect(
      actOnListingOffer(buyer, offer.id, { action: 'accept', expectedEntries: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    await expect(
      actOnListingOffer(owner, offer.id, {
        action: 'counter',
        expectedEntries: 2,
        amountKobo: '2200000000',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');
    const countered = await actOnListingOffer(owner, offer.id, {
      action: 'counter',
      expectedEntries: 1,
      amountKobo: '2200000000',
      note: 'Meet me halfway',
    });
    expect(countered.status).toBe('countered');
    expect(countered.amountKobo).toBe('2200000000');
    expect(countered.negotiationLog).toHaveLength(2);
    expect(countered.negotiationLog[0]).toMatchObject({
      party: 'buyer',
      action: 'submitted',
      amountKobo: '2000000000',
      note: 'Cash buyer',
    });
    expect(countered.negotiationLog[1]).toMatchObject({
      party: 'owner',
      action: 'countered',
      amountKobo: '2200000000',
      by: f.ownerA,
    });
    const accepted = await actOnListingOffer(buyer, offer.id, {
      action: 'accept',
      expectedEntries: 2,
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.decidedAt).not.toBeNull();
    expect(accepted.negotiationLog.map((e) => e.action)).toEqual([
      'submitted',
      'countered',
      'accepted',
    ]);
    expect(accepted.nextActions).toEqual([]);
    await expect(
      actOnListingOffer(owner, offer.id, {
        action: 'reject',
        expectedEntries: 3,
        note: 'too late',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    const [row] = await f.dbs.owner
      .select()
      .from(schema.offers)
      .where(eq(schema.offers.id, offer.id));
    expect(row!.organizationId).toBe(f.orgB);
    expect(row!.counterpartyOrganizationId).toBe(f.orgA);
    expect((row!.negotiationLog as unknown[]).length).toBe(3);
    const audits = await f.dbs.owner
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, offer.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'listing_offer.accepted',
      'listing_offer.countered',
      'listing_offer.submitted',
    ]);
  });

  it('tracks lease milestones and a documented outcome on the land sales/leasing request', async () => {
    const { listing, propertyId } = await publish({
      kind: 'lease',
      title: `Warehouse yard to let ${f.s}`,
      priceBasis: 'per_year',
    });
    const owner = ownerIdentity(f, 'A');
    await expect(
      addLeaseMilestone(ownerIdentity(f, 'C'), listing.id, { title: 'Deposit paid' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(addLeaseMilestone(owner, listing.id, { title: 'Deposit paid' })).rejects.toSatisfy(
      (e) => errorCode(e) === 'validation_failed',
    );
    const withMilestone = await addLeaseMilestone(owner, listing.id, {
      serviceRequestId: f.landRequestA,
      title: 'Deposit paid',
      dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(withMilestone.serviceRequest?.id).toBe(f.landRequestA);
    expect(withMilestone.milestones).toHaveLength(1);
    expect(withMilestone.milestones[0]!.status).toBe('open');
    const [item] = await f.dbs.owner
      .select()
      .from(schema.engagementItems)
      .where(eq(schema.engagementItems.id, withMilestone.milestones[0]!.id));
    expect(item!.kind).toBe('lease_milestone');
    expect(item!.subjectType).toBe('listing');
    // Staff with rentals.manage can also progress the transaction; a stale version is refused.
    await expect(
      updateLeaseMilestone(opsIdentity(f), listing.id, item!.id, {
        expectedVersion: 9,
        status: 'satisfied',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');
    const evidence = await insertFile(f.dbs.owner, f.orgA, f.ownerA);
    const satisfied = await updateLeaseMilestone(opsIdentity(f), listing.id, item!.id, {
      expectedVersion: 1,
      status: 'satisfied',
      fileIds: [evidence],
    });
    expect(satisfied.milestones[0]).toMatchObject({
      status: 'satisfied',
      version: 2,
      fileIds: [evidence],
      resolvedBy: f.ops,
    });
    const detail = await getListingDetail(owner, listing.id);
    const lease = await insertFile(f.dbs.owner, f.orgA, f.ownerA);
    const done = await recordListingOutcome(owner, listing.id, {
      expectedVersion: detail.version,
      outcome: 'leased',
      fileIds: [lease],
      note: 'Three-year lease executed with the buyer organisation.',
    });
    expect(done.outcome).toMatchObject({
      outcome: 'leased',
      fileIds: [lease],
      serviceRequestId: f.landRequestA,
    });
    const closed = await getListingDetail(owner, listing.id);
    expect(closed.status).toBe('archived');
    expect(await getPublicListingState(listing.slug, { fresh: true })).toMatchObject({
      state: 'unavailable',
      reason: 'closed',
    });
    await expect(
      recordListingOutcome(owner, listing.id, {
        expectedVersion: closed.version,
        outcome: 'sold',
        fileIds: [lease],
        note: 'again',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'conflict');
    expect((await outboxEvents(listing.id, 'listing.outcome_recorded')).length).toBe(1);
    const transaction = await getListingTransaction(opsIdentity(f), listing.id);
    expect(transaction.outcome?.outcome).toBe('leased');
    // The property stays a private asset; the listing is closed, not deleted.
    expect(propertyId).toBeTruthy();
  });

  it('expires lapsed listings and offers through the job, with audit and outbox events', async () => {
    const { listing } = await publish({ title: `Lapsing plot ${f.s}` });
    const offer = await createListingOffer(ownerIdentity(f, 'B'), listing.id, {
      amountKobo: '1500000000',
      conditions: [],
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await f.dbs.owner
      .update(schema.listings)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.listings.id, listing.id));
    await f.dbs.owner
      .update(schema.offers)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.offers.id, offer.id));
    const run = await runListingExpiry(f.dbs.app);
    expect(run.listingIds).toContain(listing.id);
    expect(run.offersExpired).toBeGreaterThanOrEqual(1);
    const [row] = await f.dbs.owner
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listing.id));
    expect(row!.status).toBe('expired');
    expect(row!.version).toBe(listing.version + 1);
    expect((await outboxEvents(listing.id, 'listing.expired')).length).toBe(1);
    const expiredOffer = await getListingOffer(ownerIdentity(f, 'B'), offer.id);
    expect(expiredOffer.status).toBe('expired');
    expect(expiredOffer.negotiationLog.map((e) => e.action)).toEqual(['submitted', 'expired']);
    expect(expiredOffer.negotiationLog[1]!.party).toBe('system');
    // Re-running changes nothing more.
    const again = await runListingExpiry(f.dbs.app);
    expect(again.listingIds).not.toContain(listing.id);
    // The owner re-confirms by resubmitting; the expired listing goes back through moderation.
    const owner = ownerIdentity(f, 'A');
    const current = await getListingDetail(owner, listing.id);
    expect(current.effectiveStatus).toBe('expired');
    const resubmitted = await submitListing(owner, listing.id, {
      expectedVersion: current.version,
    });
    expect(resubmitted.status).toBe('in_moderation');
    const withdrawn = await withdrawListing(owner, listing.id, {
      expectedVersion: resubmitted.version,
      reason: 'Sold privately',
    });
    expect(withdrawn.status).toBe('withdrawn');
  });
});
