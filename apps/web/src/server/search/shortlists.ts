import 'server-only';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type SearchWorkspaceDto,
  type ShortlistAccept,
  type ShortlistCreate,
  type ShortlistDto,
  type ShortlistItemAdd,
  type ShortlistItemDto,
  type ShortlistItemFeedback,
  type ShortlistItemUpdate,
  type ShortlistOutcomeDto,
  type ShortlistOutcomeInput,
  type ShortlistStatusDto,
  type ShortlistUpdate,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import {
  SEARCH_OUTCOMES,
  SHORTLIST_ITEM_STATUSES,
  isShortlistFrozen,
  type SearchOutcome,
  type ShortlistItemStatus,
} from '@simplexd/domain/search';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { createServiceRequestReport } from '@/server/engagements/reports';
import {
  assertUpdatedAt,
  ctxFor,
  notFound,
  userIdOf,
  type ServiceOptions,
} from '@/server/projects/shared';
import {
  assertRequestOpen,
  requireCustomer,
  requireStaffManage,
  requireWorkspace,
  type WorkspaceAccess,
} from './access';
import { comparisonFor, loadPublishedListings, type ListingFactsRow } from './listings';
import { listViewingsForRequest } from './viewings';

/**
 * Engagement shortlists (property search and purchase representation).
 * Staff build a shortlist from published listings or external references
 * (source reference required; asking price optional and never invented),
 * share it, and the customer compares the entries side by side, rates them
 * and leaves feedback. Completion is either the customer accepting the
 * shortlist or staff recording the search outcome, which drafts a
 * `search_outcome` report under the request (reviewed and released like
 * every customer-facing report) and freezes the shortlist.
 *
 * Statuses: `draft` (staff only) → `shared` → `accepted` | `outcome_recorded`.
 * Rows carry no version counter: `expectedUpdatedAt` is the concurrency token.
 */

type ShortlistRow = typeof schema.shortlists.$inferSelect;
type ItemRow = typeof schema.shortlistItems.$inferSelect;

const ACCEPTANCE_NOTE_PREFIX = 'Shortlist accepted.';

export function normalizeShortlistStatus(status: string): ShortlistStatusDto {
  if (status === 'shared' || status === 'accepted' || status === 'outcome_recorded') return status;
  return 'draft';
}

function normalizeItemStatus(status: string): ShortlistItemStatus {
  return (SHORTLIST_ITEM_STATUSES as readonly string[]).includes(status)
    ? (status as ShortlistItemStatus)
    : 'candidate';
}

interface Loaded {
  row: ShortlistRow;
  ws: WorkspaceAccess;
}

async function loadShortlist(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
): Promise<Loaded> {
  const [row] = await tx.select().from(schema.shortlists).where(eq(schema.shortlists.id, id));
  if (!row || !row.serviceRequestId) throw notFound('shortlist');
  const ws = await requireWorkspace(tx, identity, row.serviceRequestId);
  if (ws.viewer === 'customer' && normalizeShortlistStatus(row.status) === 'draft') {
    throw notFound('shortlist');
  }
  return { row, ws };
}

async function loadItem(
  tx: Transaction,
  identity: RequestIdentity,
  itemId: string,
): Promise<Loaded & { item: ItemRow }> {
  const [item] = await tx
    .select()
    .from(schema.shortlistItems)
    .where(eq(schema.shortlistItems.id, itemId));
  if (!item) throw notFound('shortlist entry');
  const loaded = await loadShortlist(tx, identity, item.shortlistId);
  return { ...loaded, item };
}

/* ---------------------------------------------------------------------- */
/* Read models                                                             */
/* ---------------------------------------------------------------------- */

function tallies(items: ItemRow[]) {
  const live = items.filter((i) => i.status !== 'removed');
  return {
    considered: live.length,
    viewed: live.filter((i) => i.status === 'viewed').length,
    preferred: live.filter((i) => i.status === 'preferred').length,
    rejected: live.filter((i) => i.status === 'rejected').length,
  };
}

/** Search-outcome reports of the request the caller may read (customers: released only). */
async function loadOutcomes(
  tx: Transaction,
  serviceRequestId: string,
): Promise<Map<string, { report: typeof schema.reports.$inferSelect; findings: Record<string, unknown>; summary: string | null }>> {
  const reports = await tx
    .select()
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.serviceRequestId, serviceRequestId),
        eq(schema.reports.kind, 'search_outcome'),
      ),
    )
    .orderBy(desc(schema.reports.createdAt));
  const out = new Map<
    string,
    { report: typeof schema.reports.$inferSelect; findings: Record<string, unknown>; summary: string | null }
  >();
  for (const report of reports) {
    const version = report.releasedVersion ?? report.currentVersion;
    const [rev] = await tx
      .select({ findings: schema.reportRevisions.findings, summary: schema.reportRevisions.summary })
      .from(schema.reportRevisions)
      .where(
        and(
          eq(schema.reportRevisions.reportId, report.id),
          eq(schema.reportRevisions.version, version),
        ),
      );
    const findings =
      rev?.findings && typeof rev.findings === 'object'
        ? (rev.findings as Record<string, unknown>)
        : {};
    const shortlistId = typeof findings['shortlistId'] === 'string' ? findings['shortlistId'] : null;
    if (shortlistId && !out.has(shortlistId)) {
      out.set(shortlistId, { report, findings, summary: rev?.summary ?? null });
    }
  }
  return out;
}

async function nameOf(tx: Transaction, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await tx
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return u?.name ?? null;
}

function itemDto(item: ItemRow, listing: ListingFactsRow | null): ShortlistItemDto {
  return {
    id: item.id,
    shortlistId: item.shortlistId,
    listingId: item.listingId,
    listingSlug: listing?.slug ?? null,
    listingPublished: item.listingId ? Boolean(listing?.visible) : null,
    externalReference: item.externalReference,
    title: item.title,
    notes: item.notes,
    customerRating: item.customerRating,
    customerFeedback: item.customerFeedback,
    status: normalizeItemStatus(item.status),
    sortOrder: item.sortOrder,
    comparison: comparisonFor(
      { listingId: item.listingId, externalReference: item.externalReference, priceKobo: item.priceKobo },
      listing,
    ),
    createdAt: item.createdAt.toISOString(),
  };
}

/** Builds DTOs for several shortlists of one request (listing facts read once, under the system context). */
async function buildShortlistDtos(
  tx: Transaction,
  ws: WorkspaceAccess,
  rows: ShortlistRow[],
): Promise<ShortlistDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = await tx
    .select()
    .from(schema.shortlistItems)
    .where(inArray(schema.shortlistItems.shortlistId, ids))
    .orderBy(asc(schema.shortlistItems.sortOrder), asc(schema.shortlistItems.createdAt));
  const listingIds = [...new Set(items.map((i) => i.listingId).filter((v): v is string => !!v))];
  const listings = new Map(
    (await loadPublishedListings({ listingIds, includeHidden: true })).map((l) => [l.id, l]),
  );
  const notes = await tx
    .select()
    .from(schema.notes)
    .where(and(eq(schema.notes.entityType, 'shortlist'), inArray(schema.notes.entityId, ids)))
    .orderBy(asc(schema.notes.createdAt));
  const outcomes = await loadOutcomes(tx, ws.access.sr.id);
  const out: ShortlistDto[] = [];
  for (const row of rows) {
    const own = items.filter((i) => i.shortlistId === row.id);
    const acceptance = notes.find(
      (n) => n.entityId === row.id && n.body.startsWith(ACCEPTANCE_NOTE_PREFIX),
    );
    const outcome = outcomes.get(row.id);
    let outcomeDto: ShortlistOutcomeDto | null = null;
    if (outcome) {
      const code = outcome.findings['outcome'];
      outcomeDto = {
        outcome: (SEARCH_OUTCOMES as readonly string[]).includes(String(code))
          ? (code as SearchOutcome)
          : 'no_suitable_property',
        summary: outcome.summary ?? '',
        recordedAt: outcome.report.createdAt.toISOString(),
        recordedByName: await nameOf(tx, outcome.report.createdBy),
        tallies: tallies(own),
        reportId: outcome.report.id,
      };
    }
    out.push({
      id: row.id,
      serviceRequestId: row.serviceRequestId,
      name: row.name,
      status: normalizeShortlistStatus(row.status),
      items: own.map((i) => itemDto(i, i.listingId ? (listings.get(i.listingId) ?? null) : null)),
      acceptance: acceptance
        ? {
            acceptedAt: acceptance.createdAt.toISOString(),
            acceptedByName: await nameOf(tx, acceptance.authorUserId),
          }
        : null,
      outcome: outcomeDto,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return out;
}

async function shortlistsOf(tx: Transaction, ws: WorkspaceAccess): Promise<ShortlistRow[]> {
  const rows = await tx
    .select()
    .from(schema.shortlists)
    .where(eq(schema.shortlists.serviceRequestId, ws.access.sr.id))
    .orderBy(asc(schema.shortlists.createdAt));
  return ws.viewer === 'customer'
    ? rows.filter((r) => normalizeShortlistStatus(r.status) !== 'draft')
    : rows;
}

/** Shortlists and viewings of a request, for the customer's or staff's view. */
export async function getSearchWorkspace(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<SearchWorkspaceDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    const rows = await shortlistsOf(tx, ws);
    const shortlists = await buildShortlistDtos(tx, ws, rows);
    const viewings = await listViewingsForRequest(tx, ws);
    return {
      serviceRequestId,
      shortlists,
      viewings: viewings.items,
      unlinkedViewingAppointments: viewings.unlinkedAppointments,
      viewer: ws.viewer,
    };
  });
}

export async function getShortlist(identity: RequestIdentity, id: string): Promise<ShortlistDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { row, ws } = await loadShortlist(tx, identity, id);
    const [dto] = await buildShortlistDtos(tx, ws, [row]);
    return dto!;
  });
}

/* ---------------------------------------------------------------------- */
/* Staff: build and share                                                  */
/* ---------------------------------------------------------------------- */

const SEARCH_WORKFLOWS = ['property_search', 'purchase_support'];

export async function createShortlist(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: ShortlistCreate,
  options: ServiceOptions = {},
): Promise<ShortlistDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    if (!SEARCH_WORKFLOWS.includes(ws.workflowTemplateKey)) {
      throw new ApiError(
        'validation_failed',
        `shortlists belong to property search and purchase representation requests (this is ${ws.serviceName})`,
      );
    }
    const [row] = await tx
      .insert(schema.shortlists)
      .values({
        organizationId: ws.access.sr.organizationId,
        serviceRequestId,
        name: input.name,
        status: 'draft',
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'shortlist.created',
      entityType: 'shortlist',
      entityId: row!.id,
      organizationId: row!.organizationId,
      after: { serviceRequestId, name: row!.name },
      correlationId: options.correlationId,
    });
    const [dto] = await buildShortlistDtos(tx, ws, [row!]);
    return dto!;
  });
}

export async function updateShortlist(
  identity: RequestIdentity,
  id: string,
  input: ShortlistUpdate,
  options: ServiceOptions = {},
): Promise<ShortlistDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadShortlist(tx, identity, id);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const current = normalizeShortlistStatus(row.status);
    if (isShortlistFrozen(current)) {
      throw new ApiError('invalid_transition', `the shortlist is ${current} and can no longer change`);
    }
    const nextStatus = input.status ?? current;
    if (nextStatus === 'shared') {
      const count = await tx
        .select({ id: schema.shortlistItems.id })
        .from(schema.shortlistItems)
        .where(eq(schema.shortlistItems.shortlistId, id));
      if (count.length === 0) {
        throw new ApiError('validation_failed', 'add at least one entry before sharing the shortlist');
      }
    }
    const [updated] = await tx
      .update(schema.shortlists)
      .set({ name: input.name ?? row.name, status: nextStatus, updatedAt: new Date() })
      .where(eq(schema.shortlists.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: nextStatus !== current ? `shortlist.${nextStatus}` : 'shortlist.updated',
      entityType: 'shortlist',
      entityId: id,
      organizationId: row.organizationId,
      before: { name: row.name, status: current },
      after: { name: updated!.name, status: nextStatus },
      correlationId: options.correlationId,
    });
    if (nextStatus === 'shared' && current !== 'shared') {
      await appendOutbox(tx, {
        eventType: 'shortlist.shared',
        aggregateType: 'shortlist',
        aggregateId: id,
        organizationId: row.organizationId,
        actorUserId: actorId,
        payload: { shortlistId: id, serviceRequestId: ws.access.sr.id, name: updated!.name },
        correlationId: options.correlationId ?? null,
      });
    }
    const [dto] = await buildShortlistDtos(tx, ws, [updated!]);
    return dto!;
  });
}

export async function addShortlistItem(
  identity: RequestIdentity,
  shortlistId: string,
  input: ShortlistItemAdd,
  options: ServiceOptions = {},
): Promise<ShortlistItemDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadShortlist(tx, identity, shortlistId);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    if (isShortlistFrozen(row.status)) {
      throw new ApiError('invalid_transition', `the shortlist is ${row.status}; entries are frozen`);
    }
    const existing = await tx
      .select({ id: schema.shortlistItems.id, listingId: schema.shortlistItems.listingId, sortOrder: schema.shortlistItems.sortOrder })
      .from(schema.shortlistItems)
      .where(eq(schema.shortlistItems.shortlistId, shortlistId));
    const sortOrder = existing.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1;
    let values: typeof schema.shortlistItems.$inferInsert;
    let listing: ListingFactsRow | null = null;
    if ('listingId' in input) {
      if (existing.some((i) => i.listingId === input.listingId)) {
        throw new ApiError('conflict', 'this listing is already on the shortlist');
      }
      [listing] = await loadPublishedListings({ listingIds: [input.listingId] });
      if (!listing || !listing.visible) {
        throw new ApiError('validation_failed', 'only published listings can be shortlisted', {
          details: [{ path: 'listingId', message: 'not a published listing' }],
        });
      }
      if (listing.organizationId === ws.access.sr.organizationId) {
        throw new ApiError('validation_failed', "the customer's own listing cannot be shortlisted for them");
      }
      values = {
        shortlistId,
        listingId: listing.id,
        externalReference: null,
        title: listing.title,
        // Price and facts are read from the published revision; nothing is copied.
        priceKobo: null,
        notes: input.notes ?? null,
        status: 'candidate',
        sortOrder,
      };
    } else {
      values = {
        shortlistId,
        listingId: null,
        externalReference: input.externalReference,
        title: input.title,
        priceKobo: input.priceKobo ? BigInt(input.priceKobo) : null,
        notes: input.notes ?? null,
        status: 'candidate',
        sortOrder,
      };
    }
    const [item] = await tx.insert(schema.shortlistItems).values(values).returning();
    await tx
      .update(schema.shortlists)
      .set({ updatedAt: new Date() })
      .where(eq(schema.shortlists.id, shortlistId));
    await recordAudit(tx, identity, {
      action: 'shortlist.item_added',
      entityType: 'shortlist',
      entityId: shortlistId,
      organizationId: row.organizationId,
      after: {
        itemId: item!.id,
        listingId: item!.listingId,
        externalReference: item!.externalReference,
        title: item!.title,
        priceKobo: item!.priceKobo?.toString() ?? null,
      },
      correlationId: options.correlationId,
    });
    return itemDto(item!, listing);
  });
}

export async function updateShortlistItem(
  identity: RequestIdentity,
  itemId: string,
  input: ShortlistItemUpdate,
  options: ServiceOptions = {},
): Promise<ShortlistItemDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws, item } = await loadItem(tx, identity, itemId);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    if (isShortlistFrozen(row.status)) {
      throw new ApiError('invalid_transition', `the shortlist is ${row.status}; entries are frozen`);
    }
    if (item.listingId && (input.title !== undefined || input.priceKobo !== undefined || input.externalReference !== undefined)) {
      throw new ApiError(
        'validation_failed',
        'a listing-backed entry takes its title and price from the published listing',
      );
    }
    const [updated] = await tx
      .update(schema.shortlistItems)
      .set({
        notes: input.notes === undefined ? item.notes : input.notes,
        status: input.status ?? item.status,
        sortOrder: input.sortOrder ?? item.sortOrder,
        title: input.title ?? item.title,
        externalReference: input.externalReference ?? item.externalReference,
        priceKobo:
          input.priceKobo === undefined
            ? item.priceKobo
            : input.priceKobo === null
              ? null
              : BigInt(input.priceKobo),
      })
      .where(eq(schema.shortlistItems.id, itemId))
      .returning();
    await tx
      .update(schema.shortlists)
      .set({ updatedAt: new Date() })
      .where(eq(schema.shortlists.id, row.id));
    await recordAudit(tx, identity, {
      action: 'shortlist.item_updated',
      entityType: 'shortlist',
      entityId: row.id,
      organizationId: row.organizationId,
      before: { itemId, status: item.status, priceKobo: item.priceKobo?.toString() ?? null },
      after: { itemId, status: updated!.status, priceKobo: updated!.priceKobo?.toString() ?? null },
      correlationId: options.correlationId,
    });
    const [listing] = updated!.listingId
      ? await loadPublishedListings({ listingIds: [updated!.listingId], includeHidden: true })
      : [null];
    return itemDto(updated!, listing ?? null);
  });
}

/* ---------------------------------------------------------------------- */
/* Customer: compare, rate, accept                                         */
/* ---------------------------------------------------------------------- */

export async function giveShortlistFeedback(
  identity: RequestIdentity,
  itemId: string,
  input: ShortlistItemFeedback,
  options: ServiceOptions = {},
): Promise<ShortlistItemDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws, item } = await loadItem(tx, identity, itemId);
    requireCustomer(identity, ws, 'org.comment');
    assertRequestOpen(ws);
    const status = normalizeShortlistStatus(row.status);
    if (status !== 'shared') {
      throw new ApiError(
        'invalid_transition',
        status === 'draft' ? 'shortlist not found' : `the shortlist is ${status}; feedback is closed`,
      );
    }
    const nextStatus =
      input.preference === undefined
        ? item.status
        : input.preference === 'candidate' && (item.status === 'preferred' || item.status === 'rejected')
          ? 'candidate'
          : input.preference === 'candidate'
            ? item.status
            : input.preference;
    const [updated] = await tx
      .update(schema.shortlistItems)
      .set({
        customerRating: input.rating === undefined ? item.customerRating : input.rating,
        customerFeedback: input.feedback === undefined ? item.customerFeedback : input.feedback,
        status: nextStatus,
      })
      .where(eq(schema.shortlistItems.id, itemId))
      .returning();
    await recordAudit(tx, identity, {
      action: 'shortlist.item_feedback',
      entityType: 'shortlist',
      entityId: row.id,
      organizationId: row.organizationId,
      after: { itemId, rating: updated!.customerRating, status: updated!.status },
      correlationId: options.correlationId,
    });
    const [listing] = updated!.listingId
      ? await loadPublishedListings({ listingIds: [updated!.listingId], includeHidden: true })
      : [null];
    return itemDto(updated!, listing ?? null);
  });
}

export async function acceptShortlist(
  identity: RequestIdentity,
  id: string,
  input: ShortlistAccept,
  options: ServiceOptions = {},
): Promise<ShortlistDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadShortlist(tx, identity, id);
    requireCustomer(identity, ws, 'org.quotes.accept');
    assertRequestOpen(ws);
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const status = normalizeShortlistStatus(row.status);
    if (status !== 'shared') {
      throw new ApiError('invalid_transition', `a ${status} shortlist cannot be accepted`);
    }
    const [updated] = await tx
      .update(schema.shortlists)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(schema.shortlists.id, id))
      .returning();
    await tx.insert(schema.notes).values({
      organizationId: row.organizationId,
      entityType: 'shortlist',
      entityId: id,
      body: input.note ? `${ACCEPTANCE_NOTE_PREFIX} ${input.note}` : ACCEPTANCE_NOTE_PREFIX,
      visibility: 'customer',
      authorUserId: actorId,
    });
    await recordAudit(tx, identity, {
      action: 'shortlist.accepted',
      entityType: 'shortlist',
      entityId: id,
      organizationId: row.organizationId,
      before: { status },
      after: { status: 'accepted', note: input.note ?? null },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'shortlist.accepted',
      aggregateType: 'shortlist',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: actorId,
      payload: {
        shortlistId: id,
        serviceRequestId: ws.access.sr.id,
        name: row.name,
        recipientUserIds: ws.access.staffAssigneeIds,
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await buildShortlistDtos(tx, ws, [updated!]);
    return dto!;
  });
}

/* ---------------------------------------------------------------------- */
/* Staff: documented search outcome                                        */
/* ---------------------------------------------------------------------- */

const OUTCOME_LABELS: Record<SearchOutcome, string> = {
  property_selected: 'A property was selected from the shortlist',
  proceeding_to_purchase: 'Proceeding to purchase representation',
  no_suitable_property: 'No suitable property was found within the brief',
  customer_paused_search: 'The customer paused the search',
  purchased_elsewhere: 'The customer secured a property outside the engagement',
};

/**
 * Records the outcome: drafts a `search_outcome` report under the request
 * (the customer reads it once a different reviewer releases it) and freezes
 * the shortlist as `outcome_recorded`.
 */
export async function recordShortlistOutcome(
  identity: RequestIdentity,
  id: string,
  input: ShortlistOutcomeInput,
  options: ServiceOptions = {},
): Promise<ShortlistDto> {
  const actorId = userIdOf(identity);
  const prepared = await withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws } = await loadShortlist(tx, identity, id);
    requireStaffManage(identity, ws);
    assertRequestOpen(ws);
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const status = normalizeShortlistStatus(row.status);
    if (status === 'outcome_recorded') {
      throw new ApiError('invalid_transition', 'the outcome of this shortlist was already recorded');
    }
    const items = await tx
      .select()
      .from(schema.shortlistItems)
      .where(eq(schema.shortlistItems.shortlistId, id))
      .orderBy(asc(schema.shortlistItems.sortOrder));
    const viewings = await listViewingsForRequest(tx, ws);
    return { row, ws, items, viewings: viewings.items, status };
  });
  const { row, ws, items, viewings } = prepared;
  const t = tallies(items);
  const body = [
    '## Outcome',
    '',
    `${OUTCOME_LABELS[input.outcome]}.`,
    '',
    input.summary,
    '',
    '## Shortlist considered',
    '',
    `${t.considered} entries were considered (${t.viewed} viewed, ${t.preferred} preferred by the customer, ${t.rejected} rejected).`,
    '',
    ...items
      .filter((i) => i.status !== 'removed')
      .map(
        (i) =>
          `- ${i.title}${i.externalReference ? ` (source: ${i.externalReference})` : ''} — ${i.status.replace(/_/g, ' ')}${i.customerRating ? `, rated ${i.customerRating}/5` : ''}${i.customerFeedback ? `: ${i.customerFeedback}` : ''}`,
      ),
    '',
    '## Viewings and feedback',
    '',
    viewings.length === 0
      ? 'No viewings were recorded.'
      : viewings
          .map(
            (v) =>
              `- ${v.title}: ${v.status.replace(/_/g, ' ')}${v.scheduledAt ? ` on ${v.scheduledAt.slice(0, 10)}` : ''}${v.feedback ? ` — "${v.feedback}"` : ''}`,
          )
          .join('\n'),
    '',
  ].join('\n');
  const report = await createServiceRequestReport(
    identity,
    ws.access.sr.id,
    {
      kind: 'search_outcome',
      title: `Search outcome — ${row.name}`,
      referenceItems: false,
      initialRevision: {
        summary: `${OUTCOME_LABELS[input.outcome]}. ${input.summary}`.slice(0, 2000),
        bodyMarkdown: body,
        findings: {
          shortlistId: id,
          outcome: input.outcome,
          tallies: t,
          entries: items.map((i) => ({
            id: i.id,
            title: i.title,
            listingId: i.listingId,
            externalReference: i.externalReference,
            status: i.status,
            customerRating: i.customerRating,
          })),
        },
        attachmentFileIds: [],
      },
    },
    options,
  );
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [updated] = await tx
      .update(schema.shortlists)
      .set({ status: 'outcome_recorded', updatedAt: new Date() })
      .where(eq(schema.shortlists.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'shortlist.outcome_recorded',
      entityType: 'shortlist',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: prepared.status },
      after: { status: 'outcome_recorded', outcome: input.outcome, reportId: report.id },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'shortlist.outcome_recorded',
      aggregateType: 'shortlist',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: actorId,
      payload: {
        shortlistId: id,
        serviceRequestId: ws.access.sr.id,
        outcome: input.outcome,
        reportId: report.id,
      },
      correlationId: options.correlationId ?? null,
    });
    const [dto] = await buildShortlistDtos(tx, ws, [updated!]);
    return dto!;
  });
}
