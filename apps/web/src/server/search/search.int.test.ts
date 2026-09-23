import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withActor } from '@simplexd/db';
import { runSavedSearchAlerts, savedSearchAlertKey } from '@simplexd/notifications';
import {
  cleanupSearchFixture,
  createSearchFixture,
  customerA,
  customerB,
  errorCode,
  insertListing,
  staff,
  type SearchFixture,
} from './testing/fixtures';
import {
  createSavedSearch,
  getSavedSearch,
  getSavedSearchMatches,
  updateSavedSearch,
} from './saved-searches';
import {
  acceptShortlist,
  addShortlistItem,
  createShortlist,
  getSearchWorkspace,
  getShortlist,
  giveShortlistFeedback,
  recordShortlistOutcome,
  updateShortlist,
} from './shortlists';
import { giveViewingFeedback, requestViewing, updateViewing } from './viewings';

/**
 * Property search (brief §8): saved searches with idempotent alerts, the
 * engagement shortlist with an honest side-by-side comparison, viewings with
 * feedback, and completion by acceptance or a documented outcome. Every id
 * is checked across organisations.
 */

let f: SearchFixture;

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => errorCode(e),
  );

beforeAll(async () => {
  f = await createSearchFixture();
});

afterAll(async () => {
  await cleanupSearchFixture(f);
});

describe('saved searches and alerts', () => {
  let searchId = '';
  let matching = '';
  let tooExpensive = '';
  let earlier = '';

  it('creates a saved search that another user cannot read (row-level security and service)', async () => {
    const dto = await createSavedSearch(customerA(f), {
      name: 'Lekki homes under 60m',
      criteria: {
        listingKinds: ['sale'],
        propertyKinds: [],
        marketIds: [f.marketId],
        stateIds: [],
        maxPriceKobo: (60_000_000n * 100n).toString(),
        requireTenureDisclosed: true,
        requireTitleDisclosure: false,
        requiredVerificationChecks: [],
      },
      alertsEnabled: true,
    });
    searchId = dto.id;
    expect(dto.alertsEnabled).toBe(true);
    expect(dto.lastRunAt).not.toBeNull();
    // Direct read as the other user under row-level security: nothing.
    const rows = await withActor(
      f.dbs.app,
      { userId: f.ownerB, organizationId: f.orgB, staff: false },
      (tx) => tx.select().from(schema.savedSearches).where(eq(schema.savedSearches.id, searchId)),
    );
    expect(rows).toHaveLength(0);
    expect(await code(getSavedSearch(customerB(f), searchId))).toBe('not_found');
    expect(
      await code(
        updateSavedSearch(customerB(f), searchId, {
          name: 'hijack',
          expectedUpdatedAt: dto.updatedAt,
        }),
      ),
    ).toBe('not_found');
    await expect(getSavedSearch(customerA(f), searchId)).resolves.toMatchObject({ id: searchId });
  });

  it('refuses criteria that would match every listing', async () => {
    expect(
      await code(
        createSavedSearch(customerA(f), {
          name: 'Everything',
          criteria: {
            listingKinds: [],
            propertyKinds: [],
            marketIds: [],
            stateIds: [],
            requireTenureDisclosed: false,
            requireTitleDisclosure: false,
            requiredVerificationChecks: [],
          },
          alertsEnabled: false,
        }),
      ),
    ).toBe('validation_failed');
  });

  it('alerts only new matching listings and never twice', async () => {
    const now = new Date();
    earlier = await insertListing(f, {
      title: 'Published before the search existed',
      publishedAt: new Date(now.getTime() - 3 * 60 * 60_000),
    });
    matching = await insertListing(f, { title: 'Lekki three-bed', publishedAt: now });
    tooExpensive = await insertListing(f, {
      title: 'Banana Island mansion',
      priceKobo: 900_000_000n * 100n,
      publishedAt: now,
    });
    await insertListing(f, { title: 'No tenure disclosed', tenure: null, publishedAt: now });
    await insertListing(f, { title: 'Other market', marketId: f.otherMarketId, publishedAt: now });
    const first = await runSavedSearchAlerts(f.dbs.app, {
      savedSearchIds: [searchId],
      now: new Date(now.getTime() + 1000),
    });
    expect(first.searches).toBe(1);
    expect(first.alerted).toBe(1);
    const jobs = await f.dbs.owner
      .select({ dedupeKey: schema.jobs.dedupeKey, payload: schema.jobs.payload })
      .from(schema.jobs)
      .where(like(schema.jobs.dedupeKey, `saved-search-alert:${searchId}:%`));
    expect(jobs.map((j) => j.dedupeKey)).toEqual([savedSearchAlertKey(searchId, matching)]);
    const event = (
      jobs[0]!.payload as { event: { type: string; payload: Record<string, unknown> } }
    ).event;
    expect(event.type).toBe('saved_search.matched');
    expect(event.payload).toMatchObject({ listingId: matching, recipientUserIds: [f.ownerA] });

    // A second run in the overlap window re-evaluates the same listing but never re-alerts.
    const second = await runSavedSearchAlerts(f.dbs.app, {
      savedSearchIds: [searchId],
      now: new Date(now.getTime() + 2000),
    });
    expect(second.alerted).toBe(0);
    expect(second.alreadyAlerted).toBeGreaterThanOrEqual(1);

    // A listing published later is announced once; the earlier one never is.
    const later = await insertListing(f, {
      title: 'Lekki four-bed',
      publishedAt: new Date(now.getTime() + 5000),
    });
    const third = await runSavedSearchAlerts(f.dbs.app, {
      savedSearchIds: [searchId],
      now: new Date(now.getTime() + 10_000),
    });
    expect(third.alerted).toBe(1);
    const all = await f.dbs.owner
      .select({ dedupeKey: schema.jobs.dedupeKey })
      .from(schema.jobs)
      .where(like(schema.jobs.dedupeKey, `saved-search-alert:${searchId}:%`));
    expect(all.map((j) => j.dedupeKey).sort()).toEqual(
      [savedSearchAlertKey(searchId, matching), savedSearchAlertKey(searchId, later)].sort(),
    );
    expect(all.some((j) => j.dedupeKey === savedSearchAlertKey(searchId, earlier))).toBe(false);
    expect(all.some((j) => j.dedupeKey === savedSearchAlertKey(searchId, tooExpensive))).toBe(
      false,
    );
    // The job did not disturb the owner's concurrency token.
    const [row] = await f.dbs.owner
      .select()
      .from(schema.savedSearches)
      .where(eq(schema.savedSearches.id, searchId));
    expect(row!.lastRunAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + 10_000);
  });

  it('previews current matches from published listings only', async () => {
    const matches = await getSavedSearchMatches(customerA(f), searchId);
    const ids = matches.items.map((m) => m.id);
    expect(ids).toContain(matching);
    expect(ids).toContain(earlier);
    expect(ids).not.toContain(tooExpensive);
    const dto = matches.items.find((m) => m.id === matching)!;
    expect(dto).toMatchObject({ priceKobo: (50_000_000n * 100n).toString(), tenure: 'freehold' });
    expect(Object.keys(dto)).not.toContain('address');
  });
});

describe('shortlists, comparison and viewings', () => {
  let shortlistId = '';
  let listingItem = '';
  let externalItem = '';
  let listingId = '';
  let updatedAt = '';

  it('staff build a shortlist from a published listing and external references', async () => {
    listingId = await insertListing(f, {
      title: 'Ikoyi terrace',
      areaM2: '420.50',
      checks: [{ item: 'title_document_sighted' }],
    });
    const sl = await createShortlist(staff(f.pm, 'project_manager'), f.searchA, {
      name: 'First round',
    });
    shortlistId = sl.id;
    expect(sl.status).toBe('draft');
    const a = await addShortlistItem(staff(f.pm, 'project_manager'), shortlistId, { listingId });
    listingItem = a.id;
    expect(a.comparison.price).toEqual({
      value: (50_000_000n * 100n).toString(),
      source: 'listing',
    });
    expect(a.comparison.area).toEqual({ value: '420.50', source: 'listing' });
    expect(a.comparison.verification.source).toBe('listing');
    expect(a.comparison.verification.value?.checks[0]?.item).toBe('title_document_sighted');
    const b = await addShortlistItem(staff(f.pm, 'project_manager'), shortlistId, {
      externalReference: 'Agent Bola, +234 800 000 0000, ref 77',
      title: 'Off-market duplex in Ajah',
      priceKobo: (48_000_000n * 100n).toString(),
    });
    externalItem = b.id;
    expect(b.comparison.price).toEqual({
      value: (48_000_000n * 100n).toString(),
      source: 'shortlist_entry',
    });
    expect(b.comparison.tenure).toEqual({ value: null, source: null });
    const c = await addShortlistItem(staff(f.pm, 'project_manager'), shortlistId, {
      externalReference: 'PropertyPro listing 12345',
      title: 'Price on application',
    });
    // Nothing is invented for an undisclosed price.
    expect(c.comparison.price).toEqual({ value: null, source: null });
    expect(c.comparison.titleDisclosure).toEqual({ value: null, source: null });
    // Duplicates and unpublished listings are refused; listing entries keep the listing's price.
    expect(
      await code(addShortlistItem(staff(f.pm, 'project_manager'), shortlistId, { listingId })),
    ).toBe('conflict');
    const withdrawn = await insertListing(f, { title: 'Withdrawn', status: 'withdrawn' });
    expect(
      await code(
        addShortlistItem(staff(f.pm, 'project_manager'), shortlistId, { listingId: withdrawn }),
      ),
    ).toBe('validation_failed');
  });

  it('is visible only to the customer organisation and staff attached to the request', async () => {
    // Draft: the customer does not see it yet.
    const draftView = await getSearchWorkspace(customerA(f), f.searchA);
    expect(draftView.shortlists).toHaveLength(0);
    expect(await code(getShortlist(customerA(f), shortlistId))).toBe('not_found');
    // Another organisation and an unassigned project manager never do.
    expect(await code(getShortlist(customerB(f), shortlistId))).toBe('not_found');
    expect(await code(getSearchWorkspace(customerB(f), f.searchA))).toBe('not_found');
    expect(await code(getShortlist(staff(f.otherPm, 'project_manager'), shortlistId))).toBe(
      'forbidden',
    );
    expect(
      await code(
        updateShortlist(staff(f.otherPm, 'project_manager'), shortlistId, {
          status: 'shared',
          expectedUpdatedAt: new Date().toISOString(),
        }),
      ),
    ).toBe('forbidden');
    // The operations manager and the assigned project manager do.
    const ops = await getShortlist(staff(f.ops, 'operations_manager'), shortlistId);
    expect(ops.items).toHaveLength(3);
    const shared = await updateShortlist(staff(f.pm, 'project_manager'), shortlistId, {
      status: 'shared',
      expectedUpdatedAt: ops.updatedAt,
    });
    expect(shared.status).toBe('shared');
    updatedAt = shared.updatedAt;
    const view = await getSearchWorkspace(customerA(f), f.searchA);
    expect(view.shortlists.map((s) => s.id)).toEqual([shortlistId]);
    expect(view.viewer).toBe('customer');
    const [event] = await f.dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'shortlist.shared'),
          eq(schema.outboxEvents.aggregateId, shortlistId),
        ),
      );
    expect(event).toBeDefined();
  });

  it('rejects a stale concurrency token', async () => {
    expect(
      await code(
        updateShortlist(staff(f.pm, 'project_manager'), shortlistId, {
          name: 'Renamed',
          expectedUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    ).toBe('version_conflict');
  });

  it('lets the customer rate entries and request viewings, and staff run the viewing', async () => {
    const rated = await giveShortlistFeedback(customerA(f), listingItem, {
      rating: 4,
      feedback: 'Good street, small garden',
      preference: 'preferred',
    });
    expect(rated).toMatchObject({ customerRating: 4, status: 'preferred' });
    expect(await code(giveShortlistFeedback(customerB(f), listingItem, { rating: 1 }))).toBe(
      'not_found',
    );
    // External entries need a booked viewing appointment.
    expect(
      await code(requestViewing(customerA(f), f.searchA, { shortlistItemId: externalItem })),
    ).toBe('validation_failed');
    const viewing = await requestViewing(customerA(f), f.searchA, {
      shortlistItemId: listingItem,
      preferredTimes: 'Weekday mornings',
    });
    expect(viewing.status).toBe('requested');
    expect(viewing.title).toBe('Ikoyi terrace');
    expect(
      await code(requestViewing(customerA(f), f.searchA, { shortlistItemId: listingItem })),
    ).toBe('conflict');
    // Feedback before the viewing happened is refused; staff confirm then complete it.
    expect(
      await code(
        giveViewingFeedback(customerA(f), viewing.id, {
          feedback: 'Too early',
          expectedUpdatedAt: viewing.updatedAt,
        }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        updateViewing(customerA(f), viewing.id, {
          status: 'confirmed',
          expectedUpdatedAt: viewing.updatedAt,
        }),
      ),
    ).toBe('forbidden');
    const confirmed = await updateViewing(staff(f.pm, 'project_manager'), viewing.id, {
      status: 'confirmed',
      scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
      expectedUpdatedAt: viewing.updatedAt,
    });
    expect(confirmed.status).toBe('confirmed');
    const done = await updateViewing(staff(f.pm, 'project_manager'), viewing.id, {
      status: 'completed',
      expectedUpdatedAt: confirmed.updatedAt,
    });
    expect(done.status).toBe('completed');
    expect(
      await code(
        updateViewing(staff(f.pm, 'project_manager'), viewing.id, {
          status: 'confirmed',
          expectedUpdatedAt: done.updatedAt,
        }),
      ),
    ).toBe('invalid_transition');
    const withFeedback = await giveViewingFeedback(customerA(f), viewing.id, {
      feedback: 'Loved it, damp patch in the kitchen',
      expectedUpdatedAt: done.updatedAt,
    });
    expect(withFeedback.feedback).toContain('damp patch');
    const view = await getSearchWorkspace(customerA(f), f.searchA);
    expect(view.viewings.map((v) => v.id)).toEqual([viewing.id]);
    // The customer's own preference is never overwritten by the viewing outcome.
    expect(view.shortlists[0]!.items.find((i) => i.id === listingItem)!.status).toBe('preferred');
  });

  it('completes by acceptance (approval authority) and freezes the shortlist', async () => {
    const current = await getShortlist(customerA(f), shortlistId);
    updatedAt = current.updatedAt;
    expect(
      await code(acceptShortlist(customerB(f), shortlistId, { expectedUpdatedAt: updatedAt })),
    ).toBe('not_found');
    const accepted = await acceptShortlist(customerA(f, 'approver'), shortlistId, {
      expectedUpdatedAt: updatedAt,
      note: 'Go ahead with the Ikoyi terrace',
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptance?.acceptedByName).toContain(f.approverA);
    expect(
      await code(
        addShortlistItem(staff(f.pm, 'project_manager'), shortlistId, {
          externalReference: 'late entry',
          title: 'Late entry',
        }),
      ),
    ).toBe('invalid_transition');
    expect(await code(giveShortlistFeedback(customerA(f), listingItem, { rating: 2 }))).toBe(
      'invalid_transition',
    );
  });

  it('records a documented search outcome as a report under the request', async () => {
    const sl = await createShortlist(staff(f.pm, 'project_manager'), f.searchA, {
      name: 'Second round',
    });
    await addShortlistItem(staff(f.pm, 'project_manager'), sl.id, {
      externalReference: 'Agent Chidi ref 9',
      title: 'Yaba flat',
    });
    const shared = await updateShortlist(staff(f.pm, 'project_manager'), sl.id, {
      status: 'shared',
      expectedUpdatedAt: sl.updatedAt,
    });
    expect(
      await code(
        recordShortlistOutcome(customerA(f), sl.id, {
          outcome: 'no_suitable_property',
          summary: 'Customers do not record outcomes',
          expectedUpdatedAt: shared.updatedAt,
        }),
      ),
    ).toBe('forbidden');
    const done = await recordShortlistOutcome(staff(f.pm, 'project_manager'), sl.id, {
      outcome: 'customer_paused_search',
      summary:
        'The customer paused the search until the new financial year; two entries were viewed.',
      expectedUpdatedAt: shared.updatedAt,
    });
    expect(done.status).toBe('outcome_recorded');
    expect(done.outcome).toMatchObject({
      outcome: 'customer_paused_search',
      tallies: { considered: 1 },
    });
    const [report] = await f.dbs.owner
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.id, done.outcome!.reportId!));
    expect(report).toMatchObject({
      kind: 'search_outcome',
      serviceRequestId: f.searchA,
      status: 'draft',
    });
    // Until a reviewer releases the report the customer sees the status, not the summary.
    const customerView = await getShortlist(customerA(f), sl.id);
    expect(customerView.status).toBe('outcome_recorded');
    expect(customerView.outcome).toBeNull();
  });
});
