import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type PurchaseNegotiationEntryDto,
  type PurchaseOfferAction,
  type PurchaseOfferActionName,
  type PurchaseOfferCreate,
  type PurchaseOfferDto,
  type PurchaseOfferUpdate,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import type { ActorKind } from '@simplexd/domain/workflow';
import {
  OFFER_ACTIONS,
  appendNegotiationEntry,
  assertAppendOnly,
  checkOfferAction,
  parseNegotiationLog,
  type NegotiationEntry,
  type OfferState,
} from '@simplexd/domain/purchase';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { ctxFor, notFound, userIdOf, type ServiceOptions } from '@/server/projects/shared';
import {
  assertRequestOpen,
  assertWorkflow,
  requireCustomerOrStaff,
  requireWorkspace,
  type WorkspaceAccess,
} from '@/server/search/access';
import { loadPublishedListings } from '@/server/search/listings';

/**
 * Offers made for a represented buyer (purchase representation). The offer's
 * organisation is the buyer's; the seller's side is recorded by the
 * representative (staff). Every change appends an entry to the negotiation
 * log `{at, byUserId, action, amountKobo?, note}`; earlier entries are never
 * altered (`assertAppendOnly` runs on every write, and the log length is the
 * optimistic-concurrency token `expectedEntries`).
 *
 * `offers.conditions` holds the offer terms as a list of strings; once the
 * offer is accepted they become tracked `condition` engagement items linked
 * to the offer (`subjectType: 'offer'`). The first log entry carries the
 * subject (shortlist entry) so an offer on an external property keeps its
 * reference after the shortlist changes.
 */

type OfferRow = typeof schema.offers.$inferSelect;

interface StoredSubject {
  shortlistItemId: string | null;
  title: string;
  externalReference: string | null;
}

type LogEntry = NegotiationEntry & { subject?: StoredSubject };

function subjectOf(log: LogEntry[]): StoredSubject | null {
  const first = log.find((e) => e.subject);
  return first?.subject ?? null;
}

function conditionsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}

function actorKindOf(viewer: 'customer' | 'staff'): ActorKind {
  return viewer;
}

const ACTION_REASON_REQUIRED: Record<PurchaseOfferActionName, (from: OfferState) => boolean> = {
  submit: () => false,
  revise: () => false,
  counter: () => false,
  accept: () => false,
  reject: () => true,
  withdraw: (from) => from !== 'draft',
  expire: () => false,
  note: () => true,
};

function availableActions(
  status: OfferState,
  viewer: 'customer' | 'staff',
): PurchaseOfferDto['availableActions'] {
  const out: PurchaseOfferDto['availableActions'] = [];
  for (const action of OFFER_ACTIONS) {
    if (action === 'expire' && viewer !== 'staff') continue;
    const check = checkOfferAction({
      from: status,
      action,
      actor: actorKindOf(viewer),
      amountKobo: 1n,
      note: 'instruction recorded',
    });
    if (check.ok) out.push({ action, reasonRequired: ACTION_REASON_REQUIRED[action](status) });
  }
  return out;
}

async function toDtos(
  tx: Transaction,
  rows: OfferRow[],
  viewer: 'customer' | 'staff',
): Promise<PurchaseOfferDto[]> {
  const logs = rows.map((r) => parseNegotiationLog(r.negotiationLog) as LogEntry[]);
  const userIds = [
    ...new Set(logs.flatMap((l) => l.map((e) => e.byUserId)).filter((v): v is string => !!v)),
  ];
  const names = new Map(
    userIds.length === 0
      ? []
      : (
          await tx
            .select({ id: schema.user.id, name: schema.user.name })
            .from(schema.user)
            .where(inArray(schema.user.id, userIds))
        ).map((u) => [u.id, u.name]),
  );
  return rows.map((row, i) => {
    const log = logs[i]!;
    const subject = subjectOf(log);
    const entries: PurchaseNegotiationEntryDto[] = log.map((e) => ({
      at: e.at,
      byUserId: e.byUserId,
      byName: e.byUserId ? (names.get(e.byUserId) ?? null) : null,
      action: e.action,
      amountKobo: e.amountKobo ?? null,
      note: e.note ?? null,
      status: e.status ?? null,
      actor: e.actor ?? null,
    }));
    return {
      id: row.id,
      serviceRequestId: row.serviceRequestId!,
      listingId: row.listingId,
      shortlistItemId: subject?.shortlistItemId ?? null,
      subjectTitle: subject?.title ?? 'Property',
      externalReference: subject?.externalReference ?? null,
      amountKobo: row.amountKobo.toString(),
      currency: row.currency,
      conditions: conditionsOf(row.conditions),
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      negotiationLog: entries,
      entries: log.length,
      availableActions: availableActions(row.status, viewer),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/** Offers of a request (staff and the customer organisation see the same list). */
export async function listOffersForRequest(
  tx: Transaction,
  ws: WorkspaceAccess,
): Promise<PurchaseOfferDto[]> {
  const rows = await tx
    .select()
    .from(schema.offers)
    .where(eq(schema.offers.serviceRequestId, ws.access.sr.id))
    .orderBy(asc(schema.offers.createdAt));
  return toDtos(tx, rows, ws.viewer);
}

export async function listPurchaseOffers(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<PurchaseOfferDto[]> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    return listOffersForRequest(tx, ws);
  });
}

async function loadOffer(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
): Promise<{ row: OfferRow; ws: WorkspaceAccess; log: LogEntry[] }> {
  const [row] = await tx.select().from(schema.offers).where(eq(schema.offers.id, id));
  if (!row || !row.serviceRequestId) throw notFound('offer');
  const ws = await requireWorkspace(tx, identity, row.serviceRequestId);
  return { row, ws, log: parseNegotiationLog(row.negotiationLog) as LogEntry[] };
}

export async function getPurchaseOffer(
  identity: RequestIdentity,
  id: string,
): Promise<PurchaseOfferDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { row, ws } = await loadOffer(tx, identity, id);
    const [dto] = await toDtos(tx, [row], ws.viewer);
    return dto!;
  });
}

const PURCHASE_WORKFLOWS = ['purchase_support'];

/** Drafts an offer on a shortlisted property or a published listing. */
export async function createPurchaseOffer(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: PurchaseOfferCreate,
  options: ServiceOptions = {},
): Promise<PurchaseOfferDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const ws = await requireWorkspace(tx, identity, serviceRequestId);
    assertWorkflow(ws, PURCHASE_WORKFLOWS);
    const viewer = requireCustomerOrStaff(identity, ws, 'org.requests.create');
    assertRequestOpen(ws);
    const sr = ws.access.sr;
    let subject: StoredSubject;
    let listingId: string | null = null;
    if (input.shortlistItemId) {
      const [item] = await tx
        .select({ item: schema.shortlistItems, shortlist: schema.shortlists })
        .from(schema.shortlistItems)
        .innerJoin(schema.shortlists, eq(schema.shortlists.id, schema.shortlistItems.shortlistId))
        .where(eq(schema.shortlistItems.id, input.shortlistItemId));
      if (!item || item.shortlist.serviceRequestId !== serviceRequestId)
        throw notFound('shortlist entry');
      listingId = item.item.listingId;
      subject = {
        shortlistItemId: item.item.id,
        title: item.item.title,
        externalReference: item.item.externalReference,
      };
    } else {
      const [listing] = await loadPublishedListings({ listingIds: [input.listingId!] });
      if (!listing || !listing.visible) throw notFound('published listing');
      listingId = listing.id;
      subject = { shortlistItemId: null, title: listing.title, externalReference: null };
    }
    const open = await tx
      .select({ id: schema.offers.id })
      .from(schema.offers)
      .where(
        and(
          eq(schema.offers.serviceRequestId, serviceRequestId),
          inArray(schema.offers.status, ['draft', 'submitted', 'countered', 'accepted']),
        ),
      );
    if (open.length > 0) {
      throw new ApiError(
        'conflict',
        'this request already has a live offer; withdraw it or wait for the decision before drafting another',
        { details: { offerId: open[0]!.id } },
      );
    }
    const now = new Date().toISOString();
    const log: LogEntry[] = appendNegotiationEntry([], {
      at: now,
      byUserId: actorId,
      action: 'drafted',
      amountKobo: input.amountKobo,
      ...(input.note ? { note: input.note } : {}),
      status: 'draft',
      actor: viewer,
    });
    log[0]!.subject = subject;
    const [row] = await tx
      .insert(schema.offers)
      .values({
        organizationId: sr.organizationId,
        listingId,
        serviceRequestId,
        counterpartyOrganizationId: null,
        amountKobo: BigInt(input.amountKobo),
        conditions: input.conditions,
        status: 'draft',
        negotiationLog: log,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'purchase_offer.drafted',
      entityType: 'offer',
      entityId: row!.id,
      organizationId: sr.organizationId,
      after: {
        serviceRequestId,
        amountKobo: input.amountKobo,
        conditions: input.conditions,
        subject,
      },
      correlationId: options.correlationId,
    });
    const [dto] = await toDtos(tx, [row!], ws.viewer);
    return dto!;
  });
}

/** Edits a draft (amount, terms, expiry); every edit is logged as `amended`. */
export async function updatePurchaseOffer(
  identity: RequestIdentity,
  id: string,
  input: PurchaseOfferUpdate,
  options: ServiceOptions = {},
): Promise<PurchaseOfferDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws, log } = await loadOffer(tx, identity, id);
    const viewer = requireCustomerOrStaff(identity, ws, 'org.requests.create');
    assertRequestOpen(ws);
    if (row.status !== 'draft') {
      throw new ApiError(
        'invalid_transition',
        `a ${row.status} offer is not edited; revise it through the negotiation`,
      );
    }
    if (log.length !== input.expectedEntries) {
      throw new ApiError(
        'version_conflict',
        'the offer changed since you loaded it; reload and try again',
        {
          details: { currentEntries: log.length },
        },
      );
    }
    const amountKobo = input.amountKobo ? BigInt(input.amountKobo) : row.amountKobo;
    const conditions = input.conditions ?? conditionsOf(row.conditions);
    const expiresAt =
      input.expiresAt === undefined
        ? row.expiresAt
        : input.expiresAt
          ? new Date(input.expiresAt)
          : null;
    const next = appendNegotiationEntry(log, {
      at: new Date().toISOString(),
      byUserId: actorId,
      action: 'amended',
      amountKobo: amountKobo.toString(),
      note: `terms: ${conditions.length === 0 ? 'none' : conditions.join('; ')}`,
      status: 'draft',
      actor: viewer,
    });
    const [updated] = await tx
      .update(schema.offers)
      .set({ amountKobo, conditions, expiresAt, negotiationLog: next, updatedAt: new Date() })
      .where(eq(schema.offers.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'purchase_offer.amended',
      entityType: 'offer',
      entityId: id,
      organizationId: row.organizationId,
      before: { amountKobo: row.amountKobo.toString(), conditions: conditionsOf(row.conditions) },
      after: { amountKobo: amountKobo.toString(), conditions },
      correlationId: options.correlationId,
    });
    const [dto] = await toDtos(tx, [updated!], ws.viewer);
    return dto!;
  });
}

const TERMINAL: OfferState[] = ['accepted', 'rejected', 'withdrawn', 'expired'];

/**
 * Negotiation step. The customer (with `org.quotes.accept`, the authority to
 * commit the organisation) submits, revises, accepts a counter or withdraws;
 * staff record the seller's response (counter, accept, reject) and may act
 * for the buyer only with the customer's instruction in the note.
 */
export async function applyPurchaseOfferAction(
  identity: RequestIdentity,
  id: string,
  input: PurchaseOfferAction,
  options: ServiceOptions = {},
): Promise<PurchaseOfferDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row, ws, log } = await loadOffer(tx, identity, id);
    const commits = ['submit', 'revise', 'accept', 'withdraw'].includes(input.action);
    const viewer = requireCustomerOrStaff(
      identity,
      ws,
      commits ? 'org.quotes.accept' : 'org.comment',
    );
    if (viewer === 'customer' && ['counter', 'reject', 'expire'].includes(input.action)) {
      throw new ApiError('forbidden', "the seller's response is recorded by your representative");
    }
    assertRequestOpen(ws);
    if (log.length !== input.expectedEntries) {
      throw new ApiError(
        'version_conflict',
        'the offer changed since you loaded it; reload and try again',
        {
          details: { currentEntries: log.length },
        },
      );
    }
    const amount = input.amountKobo ? BigInt(input.amountKobo) : null;
    const check = checkOfferAction({
      from: row.status,
      action: input.action,
      actor: actorKindOf(viewer),
      amountKobo: amount,
      note: input.note ?? null,
    });
    if (!check.ok) {
      const code =
        check.code === 'actor_not_allowed'
          ? 'forbidden'
          : check.code === 'invalid_transition'
            ? 'invalid_transition'
            : 'validation_failed';
      throw new ApiError(code, check.message ?? 'invalid offer action', {
        details: { code: check.code, from: row.status, action: input.action },
      });
    }
    if (input.action === 'submit' && row.expiresAt && row.expiresAt < new Date()) {
      throw new ApiError(
        'validation_failed',
        'the offer expiry has passed; set a new expiry before submitting',
      );
    }
    const now = new Date();
    const to = check.to;
    const nextAmount = amount ?? row.amountKobo;
    const entry: NegotiationEntry = {
      at: now.toISOString(),
      byUserId: actorId,
      action: input.action === 'note' ? 'note' : LOG_ACTION[input.action],
      ...(input.action === 'note' ? {} : { amountKobo: nextAmount.toString() }),
      ...(input.note ? { note: input.note } : {}),
      ...(to ? { status: to } : {}),
      actor: viewer,
    };
    const next = appendNegotiationEntry(log, entry);
    // Defence in depth: the stored prefix must still be what we loaded.
    assertAppendOnly(parseNegotiationLog(row.negotiationLog), next);
    const patch: Partial<typeof schema.offers.$inferInsert> = {
      negotiationLog: next,
      updatedAt: now,
    };
    if (to) {
      patch.status = to;
      if (amount) patch.amountKobo = amount;
      if (input.expiresAt !== undefined)
        patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (TERMINAL.includes(to)) patch.decidedAt = now;
    }
    const [updated] = await tx
      .update(schema.offers)
      .set(patch)
      .where(and(eq(schema.offers.id, id), eq(schema.offers.status, row.status)))
      .returning();
    if (!updated) {
      throw new ApiError(
        'version_conflict',
        'the offer changed since you loaded it; reload and try again',
      );
    }
    await recordAudit(tx, identity, {
      action: `purchase_offer.${input.action}`,
      entityType: 'offer',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status, amountKobo: row.amountKobo.toString(), entries: log.length },
      after: {
        status: updated.status,
        amountKobo: updated.amountKobo.toString(),
        entries: next.length,
      },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    const subject = subjectOf(next as LogEntry[]);
    if (to === 'accepted') {
      // Offer terms become tracked conditions of the purchase (same transaction).
      const terms = conditionsOf(updated.conditions);
      for (const [i, term] of terms.entries()) {
        const [item] = await tx
          .insert(schema.engagementItems)
          .values({
            organizationId: row.organizationId,
            serviceRequestId: row.serviceRequestId!,
            kind: 'condition',
            title: term,
            detail: `Term of the accepted offer of ${formatNaira(updated.amountKobo)} on ${subject?.title ?? 'the property'}.`,
            visibility: 'customer',
            subjectType: 'offer',
            subjectId: id,
            sortOrder: i,
            createdBy: actorId,
          })
          .returning({ id: schema.engagementItems.id });
        await recordAudit(tx, identity, {
          action: 'engagement_item.created',
          entityType: 'engagement_item',
          entityId: item!.id,
          organizationId: row.organizationId,
          after: {
            serviceRequestId: row.serviceRequestId,
            kind: 'condition',
            title: term,
            offerId: id,
          },
          correlationId: options.correlationId,
        });
      }
    }
    if (to) {
      await appendOutbox(tx, {
        eventType: 'purchase_offer.updated',
        aggregateType: 'offer',
        aggregateId: id,
        organizationId: row.organizationId,
        actorUserId: actorId,
        payload: {
          offerId: id,
          serviceRequestId: row.serviceRequestId,
          status: to,
          subjectTitle: subject?.title ?? null,
          recipientUserIds: ws.access.staffAssigneeIds,
          excludeUserIds: [actorId],
        },
        correlationId: options.correlationId ?? null,
      });
    }
    const [dto] = await toDtos(tx, [updated], ws.viewer);
    return dto!;
  });
}

const LOG_ACTION: Record<Exclude<PurchaseOfferActionName, 'note'>, string> = {
  submit: 'submitted',
  revise: 'revised',
  counter: 'countered',
  accept: 'accepted',
  reject: 'rejected',
  withdraw: 'withdrawn',
  expire: 'expired',
};

function formatNaira(kobo: bigint): string {
  const whole = (kobo / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${whole}`;
}

/** Accepted offer of the request, if any (closing readiness). */
export async function acceptedOfferOf(
  tx: Transaction,
  serviceRequestId: string,
): Promise<OfferRow | null> {
  const [row] = await tx
    .select()
    .from(schema.offers)
    .where(
      and(
        eq(schema.offers.serviceRequestId, serviceRequestId),
        eq(schema.offers.status, 'accepted'),
      ),
    )
    .orderBy(asc(schema.offers.decidedAt))
    .limit(1);
  return row ?? null;
}
