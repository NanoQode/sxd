import 'server-only';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  ApiError,
  listingOutcomeKindSchema,
  type LeaseMilestoneCreate,
  type LeaseMilestoneDto,
  type LeaseMilestoneUpdate,
  type ListingOutcome,
  type ListingOutcomeDto,
  type ListingTransactionDto,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { evaluateTransition, listingMachine, type ListingState } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { actorContext, requireUserId, type ServiceOptions } from '@/server/assignments/shared';
import { assertUsableFile } from '@/server/properties/owner-authorities';
import { assertListingVersion, requireListing, type ListingRow } from './access';
import { effectiveListingStatus } from './rules';
import { invalidatePublicListings } from './public';

/**
 * Land sales/leasing transaction tracking. The transaction is the land
 * sales/leasing service request of the owning organisation; milestones and
 * the outcome are `engagement_items` on that request:
 *  - milestones: kind `lease_milestone` (lease and short-stay listings) or
 *    `closing_task` (sale listings), `subjectType = 'listing'`;
 *  - outcome: one `closing_task` with `subjectType = 'listing_outcome'`,
 *    `reference` = sold | leased | withdrawn, status satisfied, evidence files.
 * The first milestone or the outcome names the request; every later item
 * must use the same one. Completion evidence for the service is therefore
 * the authorised listing plus this documented outcome.
 */

const LAND_SERVICE_TEMPLATE = 'land_sales_leasing';
const CLOSED_REQUEST_STATUSES = ['rejected', 'cancelled', 'completed'] as const;

type ItemRow = typeof schema.engagementItems.$inferSelect;

function toMilestoneDto(row: ItemRow): LeaseMilestoneDto {
  return {
    id: row.id,
    serviceRequestId: row.serviceRequestId,
    title: row.title,
    detail: row.detail,
    reference: row.reference,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    fileIds: Array.isArray(row.fileIds) ? row.fileIds : [],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toOutcomeDto(row: ItemRow): ListingOutcomeDto | null {
  const parsed = listingOutcomeKindSchema.safeParse(row.reference);
  if (!parsed.success) return null;
  return {
    id: row.id,
    outcome: parsed.data,
    note: row.resolutionNote,
    fileIds: Array.isArray(row.fileIds) ? row.fileIds : [],
    serviceRequestId: row.serviceRequestId,
    recordedBy: row.resolvedBy ?? row.createdBy,
    recordedAt: (row.resolvedAt ?? row.createdAt).toISOString(),
  };
}

async function loadItems(tx: DbExecutor, listingId: string) {
  const milestones = await tx
    .select()
    .from(schema.engagementItems)
    .where(
      and(
        eq(schema.engagementItems.subjectType, 'listing'),
        eq(schema.engagementItems.subjectId, listingId),
        inArray(schema.engagementItems.kind, ['lease_milestone', 'closing_task']),
      ),
    )
    .orderBy(
      sql`${schema.engagementItems.dueAt} asc nulls last`,
      asc(schema.engagementItems.sortOrder),
      asc(schema.engagementItems.createdAt),
    );
  const [outcome] = await tx
    .select()
    .from(schema.engagementItems)
    .where(
      and(
        eq(schema.engagementItems.subjectType, 'listing_outcome'),
        eq(schema.engagementItems.subjectId, listingId),
      ),
    )
    .orderBy(desc(schema.engagementItems.createdAt))
    .limit(1);
  return { milestones, outcome: outcome ?? null };
}

async function requestSummary(tx: DbExecutor, id: string) {
  const [sr] = await tx
    .select({
      id: schema.serviceRequests.id,
      reference: schema.serviceRequests.reference,
      title: schema.serviceRequests.title,
      status: schema.serviceRequests.status,
      organizationId: schema.serviceRequests.organizationId,
      serviceId: schema.serviceRequests.serviceId,
    })
    .from(schema.serviceRequests)
    .where(eq(schema.serviceRequests.id, id));
  return sr ?? null;
}

async function eligibleRequests(tx: DbExecutor, organizationId: string) {
  return tx
    .select({
      id: schema.serviceRequests.id,
      reference: schema.serviceRequests.reference,
      title: schema.serviceRequests.title,
      status: schema.serviceRequests.status,
    })
    .from(schema.serviceRequests)
    .innerJoin(schema.services, eq(schema.services.id, schema.serviceRequests.serviceId))
    .where(
      and(
        eq(schema.serviceRequests.organizationId, organizationId),
        eq(schema.services.workflowTemplateKey, LAND_SERVICE_TEMPLATE),
        notInArray(schema.serviceRequests.status, [...CLOSED_REQUEST_STATUSES]),
      ),
    )
    .orderBy(desc(schema.serviceRequests.createdAt))
    .limit(20);
}

/**
 * Resolves the request the transaction is tracked on: the one already used by
 * the listing's items, else the one the caller names (validated as an open
 * land sales/leasing request of the owning organisation).
 */
async function resolveRequest(
  tx: DbExecutor,
  listing: ListingRow,
  linkedId: string | null,
  requestedId: string | undefined,
  required: boolean,
): Promise<string | null> {
  if (linkedId) {
    if (requestedId && requestedId !== linkedId) {
      throw new ApiError(
        'validation_failed',
        'this listing is already tracked on another service request',
        { details: [{ path: 'serviceRequestId', message: `use ${linkedId}` }] },
      );
    }
    return linkedId;
  }
  if (!requestedId) {
    if (!required) return null;
    throw new ApiError(
      'validation_failed',
      'name the land sales/leasing service request that represents this transaction',
      { details: [{ path: 'serviceRequestId', message: 'required for the first item' }] },
    );
  }
  const sr = await requestSummary(tx, requestedId);
  if (!sr || sr.organizationId !== listing.organizationId) {
    throw new ApiError('not_found', 'service request not found for the listing organisation');
  }
  const [service] = await tx
    .select({ template: schema.services.workflowTemplateKey })
    .from(schema.services)
    .where(eq(schema.services.id, sr.serviceId));
  if (service?.template !== LAND_SERVICE_TEMPLATE) {
    throw new ApiError('validation_failed', 'the request must be a land sales/leasing engagement', {
      details: [{ path: 'serviceRequestId', message: 'not a land sales/leasing request' }],
    });
  }
  if ((CLOSED_REQUEST_STATUSES as readonly string[]).includes(sr.status)) {
    throw new ApiError('invalid_transition', `the service request is ${sr.status}`);
  }
  return sr.id;
}

async function build(tx: DbExecutor, listing: ListingRow): Promise<ListingTransactionDto> {
  const { milestones, outcome } = await loadItems(tx, listing.id);
  const linkedId = outcome?.serviceRequestId ?? milestones[0]?.serviceRequestId ?? null;
  const sr = linkedId ? await requestSummary(tx, linkedId) : null;
  const [accepted] = await tx
    .select({
      id: schema.offers.id,
      amountKobo: schema.offers.amountKobo,
      decidedAt: schema.offers.decidedAt,
    })
    .from(schema.offers)
    .where(and(eq(schema.offers.listingId, listing.id), eq(schema.offers.status, 'accepted')))
    .orderBy(desc(schema.offers.decidedAt))
    .limit(1);
  return {
    listingId: listing.id,
    serviceRequest: sr
      ? { id: sr.id, reference: sr.reference, title: sr.title, status: sr.status }
      : null,
    eligibleRequests: linkedId ? [] : await eligibleRequests(tx, listing.organizationId),
    milestones: milestones.map(toMilestoneDto),
    outcome: outcome ? toOutcomeDto(outcome) : null,
    acceptedOffer: accepted
      ? {
          id: accepted.id,
          amountKobo: accepted.amountKobo.toString(),
          decidedAt: accepted.decidedAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function getListingTransaction(
  identity: RequestIdentity,
  listingId: string,
): Promise<ListingTransactionDto> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const listing = await requireListing(tx, identity, listingId, 'read');
    return build(tx, listing);
  });
}

export async function addLeaseMilestone(
  identity: RequestIdentity,
  listingId: string,
  input: LeaseMilestoneCreate,
  options: ServiceOptions = {},
): Promise<ListingTransactionDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const listing = await requireListing(tx, identity, listingId, 'transaction');
    if (listing.status === 'archived') {
      throw new ApiError(
        'invalid_transition',
        'the listing is closed; its transaction is complete',
      );
    }
    const { milestones, outcome } = await loadItems(tx, listingId);
    const linked = outcome?.serviceRequestId ?? milestones[0]?.serviceRequestId ?? null;
    const serviceRequestId = (await resolveRequest(
      tx,
      listing,
      linked,
      input.serviceRequestId,
      true,
    ))!;
    const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    const [item] = await tx
      .insert(schema.engagementItems)
      .values({
        organizationId: listing.organizationId,
        serviceRequestId,
        kind: listing.kind === 'sale' ? 'closing_task' : 'lease_milestone',
        title: input.title,
        detail: input.detail ?? null,
        reference: input.reference ?? null,
        status: 'open',
        visibility: 'customer',
        dueAt,
        subjectType: 'listing',
        subjectId: listingId,
        sortOrder: milestones.length,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'listing.milestone_added',
      entityType: 'engagement_item',
      entityId: item!.id,
      organizationId: listing.organizationId,
      after: {
        listingId,
        serviceRequestId,
        title: input.title,
        dueAt: dueAt?.toISOString() ?? null,
      },
      correlationId: options.correlationId,
    });
    return build(tx, listing);
  });
}

export async function updateLeaseMilestone(
  identity: RequestIdentity,
  listingId: string,
  itemId: string,
  input: LeaseMilestoneUpdate,
  options: ServiceOptions = {},
): Promise<ListingTransactionDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  return withActor(getDb(), ctx, async (tx) => {
    const listing = await requireListing(tx, identity, listingId, 'transaction');
    const [item] = await tx
      .select()
      .from(schema.engagementItems)
      .where(
        and(
          eq(schema.engagementItems.id, itemId),
          eq(schema.engagementItems.subjectType, 'listing'),
          eq(schema.engagementItems.subjectId, listingId),
        ),
      );
    if (!item) throw new ApiError('not_found', 'milestone not found');
    if (item.version !== input.expectedVersion) {
      throw new ApiError('version_conflict', 'the milestone changed; reload and try again', {
        details: { expectedVersion: input.expectedVersion, currentVersion: item.version },
      });
    }
    if (input.fileIds) {
      for (const [i, fileId] of input.fileIds.entries()) {
        await assertUsableFile(tx, fileId, listing.organizationId, `fileIds.${i}`);
      }
    }
    const resolved = ['satisfied', 'waived', 'failed', 'cancelled'].includes(input.status);
    const [updated] = await tx
      .update(schema.engagementItems)
      .set({
        status: input.status,
        resolutionNote: input.resolutionNote ?? item.resolutionNote,
        fileIds: input.fileIds ?? item.fileIds,
        resolvedAt: resolved ? now : null,
        resolvedBy: resolved ? userId : null,
        version: sql`${schema.engagementItems.version} + 1`,
      })
      .where(
        and(
          eq(schema.engagementItems.id, itemId),
          eq(schema.engagementItems.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated)
      throw new ApiError('version_conflict', 'the milestone changed; reload and try again');
    await recordAudit(tx, identity, {
      action: 'listing.milestone_updated',
      entityType: 'engagement_item',
      entityId: itemId,
      organizationId: listing.organizationId,
      before: { status: item.status, fileIds: item.fileIds },
      after: { status: input.status, fileIds: updated.fileIds },
      reason: input.resolutionNote ?? null,
      correlationId: options.correlationId,
    });
    return build(tx, listing);
  });
}

const OUTCOME_TITLES = {
  sold: 'Transaction outcome: sold',
  leased: 'Transaction outcome: leased',
  withdrawn: 'Transaction outcome: withdrawn',
} as const;

/**
 * Records the documented outcome. Sold and leased close the listing
 * (`archived`) and need evidence files and the transaction request;
 * withdrawn moves the listing to `withdrawn` and records an item only when a
 * request is tracked.
 */
export async function recordListingOutcome(
  identity: RequestIdentity,
  listingId: string,
  input: ListingOutcome,
  options: ServiceOptions = {},
): Promise<ListingTransactionDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  const result = await withActor(getDb(), ctx, async (tx) => {
    const listing = await requireListing(tx, identity, listingId, 'transaction');
    assertListingVersion(listing, input.expectedVersion);
    const { milestones, outcome } = await loadItems(tx, listingId);
    if (outcome) throw new ApiError('conflict', 'an outcome is already recorded for this listing');
    const linked = milestones[0]?.serviceRequestId ?? null;
    const serviceRequestId = await resolveRequest(
      tx,
      listing,
      linked,
      input.serviceRequestId,
      input.outcome !== 'withdrawn',
    );
    for (const [i, fileId] of input.fileIds.entries()) {
      await assertUsableFile(tx, fileId, listing.organizationId, `fileIds.${i}`);
    }
    if (input.offerId) {
      const [offer] = await tx
        .select({ id: schema.offers.id, status: schema.offers.status })
        .from(schema.offers)
        .where(and(eq(schema.offers.id, input.offerId), eq(schema.offers.listingId, listingId)));
      if (!offer || offer.status !== 'accepted') {
        throw new ApiError(
          'validation_failed',
          'offerId must be an accepted offer on this listing',
          {
            details: [{ path: 'offerId', message: 'not an accepted offer on this listing' }],
          },
        );
      }
    }
    const effective = effectiveListingStatus(listing.status, listing.expiresAt, now);
    const from: ListingState = effective === 'expired' ? 'expired' : listing.status;
    let to: ListingState;
    if (input.outcome === 'withdrawn') {
      to =
        from === 'withdrawn'
          ? 'withdrawn'
          : from === 'draft' || from === 'rejected'
            ? 'archived'
            : 'withdrawn';
    } else {
      to = 'archived';
    }
    if (from !== to) {
      const actor = identity.actor.staffRoles.length > 0 ? 'staff' : 'customer';
      const check = evaluateTransition(listingMachine, { from, to, actor, reason: input.note });
      if (!check.ok) {
        throw new ApiError('invalid_transition', check.message, { details: { code: check.code } });
      }
      const [updated] = await tx
        .update(schema.listings)
        .set({ status: to, version: sql`${schema.listings.version} + 1` })
        .where(
          and(
            eq(schema.listings.id, listingId),
            eq(schema.listings.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated)
        throw new ApiError('version_conflict', 'the listing changed; reload and try again');
    }
    let itemId: string | null = null;
    if (serviceRequestId) {
      const [item] = await tx
        .insert(schema.engagementItems)
        .values({
          organizationId: listing.organizationId,
          serviceRequestId,
          kind: 'closing_task',
          title: OUTCOME_TITLES[input.outcome],
          detail: input.offerId ? `Completed on accepted offer ${input.offerId}` : null,
          reference: input.outcome,
          status: 'satisfied',
          visibility: 'customer',
          resolvedAt: now,
          resolvedBy: userId,
          resolutionNote: input.note,
          fileIds: input.fileIds,
          subjectType: 'listing_outcome',
          subjectId: listingId,
          sortOrder: milestones.length,
          createdBy: userId,
        })
        .returning();
      itemId = item!.id;
      if (input.offerId) {
        await tx
          .update(schema.offers)
          .set({ serviceRequestId })
          .where(eq(schema.offers.id, input.offerId));
      }
    }
    await recordAudit(tx, identity, {
      action: 'listing.outcome_recorded',
      entityType: 'listing',
      entityId: listingId,
      organizationId: listing.organizationId,
      before: { status: listing.status },
      after: {
        status: to,
        outcome: input.outcome,
        serviceRequestId,
        offerId: input.offerId ?? null,
        fileIds: input.fileIds,
        engagementItemId: itemId,
      },
      reason: input.note,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'listing.outcome_recorded',
      aggregateType: 'listing',
      aggregateId: listingId,
      organizationId: listing.organizationId,
      actorUserId: userId,
      payload: {
        listingId,
        slug: listing.slug,
        outcome: input.outcome,
        serviceRequestId,
        recordedByStaff: identity.actor.staffRoles.length > 0,
      },
      correlationId: options.correlationId,
    });
    const [refreshed] = await tx
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));
    return build(tx, refreshed ?? listing);
  });
  await invalidatePublicListings();
  return result;
}
