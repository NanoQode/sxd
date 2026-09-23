import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type ListingNegotiationEntry,
  type ListingOfferAction,
  type ListingOfferCreate,
  type ListingOfferDto,
  type ListingOfferListQuery,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  systemContext,
  withActor,
  type DbExecutor,
} from '@simplexd/db';
import { assertAllowed, authorizeOrg } from '@simplexd/domain/authz';
import { evaluateTransition, listingOfferMachine } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  demote,
  elevate,
  requireUserId,
  type ServiceOptions,
} from '@/server/assignments/shared';
import { canStaffReadListings, requireListing } from './access';
import { loadPublicListingFacts } from './public';
import {
  allowedOfferActions,
  effectiveOfferStatus,
  nextOfferStatus,
  OFFER_ACTION_LOG,
  readConditions,
  readNegotiationLog,
  type OfferSide,
} from './rules';

/**
 * Offers made on a listing always name the listing's owner organisation as the
 * counterparty. Purchase-representation offers (packages under a service
 * request) share the table with a null counterparty and are not shown or acted
 * on here, even when they reference a published listing.
 */
const isListingOffer = and(
  isNotNull(schema.offers.listingId),
  isNotNull(schema.offers.counterpartyOrganizationId),
);

/**
 * Offers on published listings. The offer belongs to the buyer's organisation
 * (`organizationId`, permission `org.requests.create`) and names the listing
 * owner's organisation as counterparty (`org.listings.manage` to respond).
 * Row-level security shows an offer to both organisations and to staff only.
 * The negotiation log is append-only: every step is added with a JSON
 * concatenation in SQL and nothing ever rewrites earlier entries. Concurrent
 * responses are refused through `expectedEntries` (the log length the caller
 * saw) plus a status guard on the update.
 */

type OfferRow = typeof schema.offers.$inferSelect;

const OPEN: OfferRow['status'][] = ['submitted', 'countered'];

function sideOf(identity: RequestIdentity, offer: OfferRow): OfferSide | 'staff' | null {
  const org = identity.ctx.organizationId;
  if (org && org === offer.organizationId) return 'buyer';
  if (org && org === offer.counterpartyOrganizationId) return 'owner';
  if (identity.actor.staffRoles.length > 0 && canStaffReadListings(identity)) return 'staff';
  return null;
}

async function orgNames(tx: DbExecutor, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(inArray(schema.organization.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Slug and public title of listings (system context: a live listing under review is hidden from buyers by RLS). */
async function listingLabels(
  ids: string[],
): Promise<Map<string, { slug: string; title: string | null }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return withActor(getDb(), systemContext('listing-offer-labels'), async (tx) => {
    const rows = await tx
      .select({
        id: schema.listings.id,
        slug: schema.listings.slug,
        title: schema.listingRevisions.title,
      })
      .from(schema.listings)
      .leftJoin(
        schema.listingRevisions,
        and(
          eq(schema.listingRevisions.listingId, schema.listings.id),
          eq(
            schema.listingRevisions.version,
            sql`coalesce(${schema.listings.publishedVersion}, ${schema.listings.currentVersion})`,
          ),
        ),
      )
      .where(inArray(schema.listings.id, unique));
    return new Map(rows.map((r) => [r.id, { slug: r.slug, title: r.title }]));
  });
}

function toEntry(raw: Record<string, unknown>): ListingNegotiationEntry {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const party = str(raw['party']);
  const action = str(raw['action']);
  return {
    at: str(raw['at']) ?? new Date(0).toISOString(),
    by: str(raw['by']),
    party: party === 'buyer' || party === 'owner' ? party : 'system',
    action:
      action === 'submitted' ||
      action === 'countered' ||
      action === 'accepted' ||
      action === 'rejected' ||
      action === 'withdrawn' ||
      action === 'expired'
        ? action
        : 'submitted',
    amountKobo: str(raw['amountKobo']),
    note: str(raw['note']),
  };
}

function toDto(
  offer: OfferRow,
  viewer: OfferSide | 'staff',
  names: Map<string, string>,
  labels: Map<string, { slug: string; title: string | null }>,
  now: Date,
): ListingOfferDto {
  const effective = effectiveOfferStatus(offer.status, offer.expiresAt, now);
  const label = offer.listingId ? labels.get(offer.listingId) : undefined;
  return {
    id: offer.id,
    listingId: offer.listingId!,
    listingSlug: label?.slug ?? null,
    listingTitle: label?.title ?? null,
    buyerOrganizationId: offer.organizationId,
    buyerOrganizationName: names.get(offer.organizationId) ?? null,
    ownerOrganizationId: offer.counterpartyOrganizationId,
    ownerOrganizationName: offer.counterpartyOrganizationId
      ? (names.get(offer.counterpartyOrganizationId) ?? null)
      : null,
    amountKobo: offer.amountKobo.toString(),
    currency: offer.currency,
    conditions: readConditions(offer.conditions),
    status: offer.status,
    effectiveStatus: effective,
    negotiationLog: readNegotiationLog(offer.negotiationLog).map(toEntry),
    expiresAt: offer.expiresAt?.toISOString() ?? null,
    decidedAt: offer.decidedAt?.toISOString() ?? null,
    serviceRequestId: offer.serviceRequestId,
    viewerParty: viewer,
    nextActions: viewer === 'staff' ? [] : allowedOfferActions(effective, viewer),
    createdAt: offer.createdAt.toISOString(),
    updatedAt: offer.updatedAt.toISOString(),
  };
}

async function decorate(
  tx: DbExecutor,
  identity: RequestIdentity,
  offers: OfferRow[],
  now: Date,
): Promise<ListingOfferDto[]> {
  const names = await orgNames(
    tx,
    offers.flatMap((o) => [o.organizationId, o.counterpartyOrganizationId]),
  );
  const labels = await listingLabels(offers.flatMap((o) => (o.listingId ? [o.listingId] : [])));
  return offers.flatMap((o) => {
    const viewer = sideOf(identity, o);
    return viewer ? [toDto(o, viewer, names, labels, now)] : [];
  });
}

function assertFuture(value: string | null | undefined, path: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (date.getTime() <= Date.now()) {
    throw new ApiError('validation_failed', `${path} must be in the future`, {
      details: [{ path, message: 'must be in the future' }],
    });
  }
  return date;
}

/** Buyer organisation submits an offer on a live sale or lease listing. */
export async function createListingOffer(
  identity: RequestIdentity,
  listingId: string,
  input: ListingOfferCreate,
  options: ServiceOptions = {},
): Promise<ListingOfferDto> {
  const userId = requireUserId(identity);
  const buyerOrg = identity.ctx.organizationId;
  if (!buyerOrg) {
    throw new ApiError('forbidden', 'create or join an organisation before making an offer', {
      details: { code: 'no_organization', next: '/onboarding' },
    });
  }
  assertAllowed(
    authorizeOrg(identity.actor, 'org.requests.create', {
      type: 'offer',
      organizationId: buyerOrg,
    }),
  );
  const now = new Date();
  const listing = await loadPublicListingFacts({ id: listingId }, now);
  if (!listing || !listing.visible) {
    throw new ApiError('not_found', 'this listing is not open to offers');
  }
  if (listing.kind === 'short_stay') {
    throw new ApiError('invalid_transition', 'short stays are booked, not negotiated');
  }
  if (listing.organizationId === buyerOrg) {
    throw new ApiError('forbidden', 'an organisation cannot make an offer on its own listing');
  }
  const expiresAt = assertFuture(input.validUntil, 'validUntil');
  const entry: ListingNegotiationEntry = {
    at: now.toISOString(),
    by: userId,
    party: 'buyer',
    action: 'submitted',
    amountKobo: input.amountKobo,
    note: input.note ?? null,
  };
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const id = randomUUID();
    const [offer] = await tx
      .insert(schema.offers)
      .values({
        id,
        organizationId: buyerOrg,
        listingId: listing.id,
        propertyId: listing.propertyId,
        counterpartyOrganizationId: listing.organizationId,
        amountKobo: BigInt(input.amountKobo),
        currency: 'NGN',
        conditions: input.conditions,
        status: 'submitted',
        negotiationLog: [entry],
        expiresAt,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'listing_offer.submitted',
      entityType: 'offer',
      entityId: id,
      organizationId: buyerOrg,
      after: { listingId: listing.id, amountKobo: input.amountKobo, status: 'submitted' },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'listing_offer.submitted',
      aggregateType: 'offer',
      aggregateId: id,
      organizationId: buyerOrg,
      actorUserId: userId,
      payload: {
        offerId: id,
        listingId: listing.id,
        listingSlug: listing.slug,
        listingTitle: listing.title,
        notifyOrganizationIds: [listing.organizationId],
      },
      correlationId: options.correlationId,
    });
    const [dto] = await decorate(tx, identity, [offer!], now);
    return dto!;
  });
}

/**
 * Counter, accept, reject or withdraw. The caller's side decides what is
 * allowed (see rules.allowedOfferActions); staff read but never act.
 */
export async function actOnListingOffer(
  identity: RequestIdentity,
  offerId: string,
  input: ListingOfferAction,
  options: ServiceOptions = {},
): Promise<ListingOfferDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  return withActor(getDb(), ctx, async (tx) => {
    const [offer] = await tx
      .select()
      .from(schema.offers)
      .where(and(eq(schema.offers.id, offerId), isListingOffer));
    if (!offer) throw new ApiError('not_found', 'offer not found');
    const side = sideOf(identity, offer);
    if (side === null) throw new ApiError('not_found', 'offer not found');
    if (side === 'staff') {
      throw new ApiError('forbidden', 'staff follow negotiations; only the parties decide');
    }
    const orgId = side === 'buyer' ? offer.organizationId : offer.counterpartyOrganizationId!;
    assertAllowed(
      authorizeOrg(
        identity.actor,
        side === 'buyer' ? 'org.requests.create' : 'org.listings.manage',
        { type: 'offer', id: offer.id, organizationId: orgId },
      ),
    );
    const effective = effectiveOfferStatus(offer.status, offer.expiresAt, now);
    if (effective === 'expired') {
      throw new ApiError('invalid_transition', 'this offer has expired; a new offer can be made');
    }
    if (!allowedOfferActions(effective, side).includes(input.action)) {
      throw new ApiError(
        'invalid_transition',
        `the ${side} cannot ${input.action} an offer that is ${effective}`,
        { details: { status: effective, side } },
      );
    }
    const log = readNegotiationLog(offer.negotiationLog);
    if (log.length !== input.expectedEntries) {
      throw new ApiError('version_conflict', 'the negotiation moved on; reload the offer', {
        details: { expectedEntries: input.expectedEntries, entries: log.length },
      });
    }
    const to = nextOfferStatus(input.action, side);
    const machine = evaluateTransition(listingOfferMachine, {
      from: offer.status,
      to,
      actor: 'customer',
      reason: 'note' in input ? input.note : null,
    });
    if (!machine.ok) {
      throw new ApiError('invalid_transition', machine.message, {
        details: { code: machine.code },
      });
    }
    const amountKobo = input.action === 'counter' ? input.amountKobo : offer.amountKobo.toString();
    const entry: ListingNegotiationEntry = {
      at: now.toISOString(),
      by: userId,
      party: side,
      action: OFFER_ACTION_LOG[input.action],
      amountKobo,
      note: input.note ?? null,
    };
    const terminal = to === 'accepted' || to === 'rejected' || to === 'withdrawn';
    const nextExpiry =
      input.action === 'counter'
        ? input.validUntil === undefined
          ? offer.expiresAt
          : assertFuture(input.validUntil, 'validUntil')
        : offer.expiresAt;
    const set: Partial<typeof schema.offers.$inferInsert> = {
      status: to,
      amountKobo: BigInt(amountKobo),
      expiresAt: nextExpiry,
      decidedAt: terminal ? now : null,
    };
    if (to === 'accepted') {
      // Link the accepted offer to the listing's land transaction request, when
      // one is tracked. The owner's engagement items are not visible to the
      // buyer, so this narrowly elevated read fetches the request id only.
      await elevate(tx, ctx);
      try {
        const [item] = await tx
          .select({ serviceRequestId: schema.engagementItems.serviceRequestId })
          .from(schema.engagementItems)
          .where(
            and(
              eq(schema.engagementItems.subjectType, 'listing'),
              eq(schema.engagementItems.subjectId, offer.listingId!),
            ),
          )
          .limit(1);
        if (item) set.serviceRequestId = item.serviceRequestId;
      } finally {
        await demote(tx, ctx);
      }
    }
    const [updated] = await tx
      .update(schema.offers)
      .set({
        ...set,
        negotiationLog: sql`coalesce(${schema.offers.negotiationLog}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(
        and(
          eq(schema.offers.id, offerId),
          eq(schema.offers.status, offer.status),
          sql`jsonb_array_length(coalesce(${schema.offers.negotiationLog}, '[]'::jsonb)) = ${input.expectedEntries}`,
        ),
      )
      .returning();
    if (!updated)
      throw new ApiError('version_conflict', 'the negotiation moved on; reload the offer');
    await recordAudit(tx, identity, {
      action: `listing_offer.${OFFER_ACTION_LOG[input.action]}`,
      entityType: 'offer',
      entityId: offerId,
      organizationId: orgId,
      before: {
        status: offer.status,
        amountKobo: offer.amountKobo.toString(),
        entries: log.length,
      },
      after: { status: to, amountKobo, entries: log.length + 1, side },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    const other = side === 'buyer' ? offer.counterpartyOrganizationId : offer.organizationId;
    const labels = await listingLabels([offer.listingId!]);
    await appendOutbox(tx, {
      eventType: `listing_offer.${OFFER_ACTION_LOG[input.action]}`,
      aggregateType: 'offer',
      aggregateId: offerId,
      organizationId: orgId,
      actorUserId: userId,
      payload: {
        offerId,
        listingId: offer.listingId,
        listingSlug: labels.get(offer.listingId!)?.slug ?? null,
        listingTitle: labels.get(offer.listingId!)?.title ?? null,
        side,
        notifyOrganizationIds: other ? [other] : [],
      },
      correlationId: options.correlationId,
    });
    const [dto] = await decorate(tx, identity, [updated], now);
    return dto!;
  });
}

export async function getListingOffer(
  identity: RequestIdentity,
  offerId: string,
): Promise<ListingOfferDto> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [offer] = await tx
      .select()
      .from(schema.offers)
      .where(and(eq(schema.offers.id, offerId), isListingOffer));
    if (!offer) throw new ApiError('not_found', 'offer not found');
    const [dto] = await decorate(tx, identity, [offer], new Date());
    if (!dto) throw new ApiError('not_found', 'offer not found');
    return dto;
  });
}

/** Offers on one listing: the owner organisation and staff see all; a buyer sees its own. */
export async function listOffersForListing(
  identity: RequestIdentity,
  listingId: string,
): Promise<ListingOfferDto[]> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const isStaff = identity.actor.staffRoles.length > 0;
    const org = identity.ctx.organizationId;
    if (isStaff) await requireListing(tx, identity, listingId, 'read');
    else if (!org) return [];
    const rows = await tx
      .select()
      .from(schema.offers)
      .where(
        and(
          eq(schema.offers.listingId, listingId),
          isListingOffer,
          isStaff
            ? undefined
            : or(
                eq(schema.offers.organizationId, org!),
                eq(schema.offers.counterpartyOrganizationId, org!),
              ),
        ),
      )
      .orderBy(desc(schema.offers.createdAt));
    return decorate(tx, identity, rows, new Date());
  });
}

/** The active organisation's offers on either side (staff: every listing offer). */
export async function listMyListingOffers(
  identity: RequestIdentity,
  query: ListingOfferListQuery,
): Promise<ListingOfferDto[]> {
  requireUserId(identity);
  const isStaff = identity.actor.staffRoles.length > 0;
  const org = identity.ctx.organizationId;
  if (isStaff && !canStaffReadListings(identity)) {
    throw new ApiError('forbidden', 'listing offers need content.publish or rentals.manage');
  }
  if (!isStaff && !org) return [];
  return withActor(getDb(), identity.ctx, async (tx) => {
    const sideFilter = isStaff
      ? undefined
      : query.side === 'buyer'
        ? eq(schema.offers.organizationId, org!)
        : query.side === 'owner'
          ? eq(schema.offers.counterpartyOrganizationId, org!)
          : or(
              eq(schema.offers.organizationId, org!),
              eq(schema.offers.counterpartyOrganizationId, org!),
            );
    const rows = await tx
      .select()
      .from(schema.offers)
      .where(
        and(
          isListingOffer,
          sideFilter,
          query.status ? eq(schema.offers.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(schema.offers.updatedAt))
      .limit(query.limit);
    return decorate(tx, identity, rows, new Date());
  });
}

export { OPEN as OPEN_OFFER_STATUSES };
