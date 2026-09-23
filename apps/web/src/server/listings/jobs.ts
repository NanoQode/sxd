import 'server-only';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { ApiError, type ListingExpiryRunDto } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, systemContext, withActor, type Database } from '@simplexd/db';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { invalidatePublicListings } from './public';

/**
 * The listing expiry job (`listings.expire_lapsed`, hourly in the worker;
 * staff can run it on demand through `POST /api/v1/admin/listings/expiry-runs`).
 * Runs under the system context:
 *  1. published listings whose availability window has passed become
 *     `expired` (the public pages already hide them from the moment the window
 *     closes; this records it, audits it and notifies the owner);
 *  2. open listing offers past their validity date become `expired`, with an
 *     `expired` entry appended to their negotiation log.
 * Each statement only touches rows still in the open state, so re-running is
 * safe. The worker handler (apps/worker/src/handlers/listings.ts) runs the
 * same statements.
 */
export async function runListingExpiry(
  db: Database,
  options: { now?: Date; correlationId?: string } = {},
): Promise<ListingExpiryRunDto> {
  const now = options.now ?? new Date();
  const correlationId = options.correlationId ?? `listing-expiry:${now.toISOString()}`;
  const result = await withActor(db, systemContext(correlationId), async (tx) => {
    const expired = await tx
      .update(schema.listings)
      .set({ status: 'expired', version: sql`${schema.listings.version} + 1` })
      .where(
        and(
          eq(schema.listings.status, 'published'),
          isNotNull(schema.listings.expiresAt),
          lte(schema.listings.expiresAt, now),
        ),
      )
      .returning();
    for (const l of expired) {
      const [rev] = l.publishedVersion
        ? await tx
            .select({ title: schema.listingRevisions.title })
            .from(schema.listingRevisions)
            .where(
              and(
                eq(schema.listingRevisions.listingId, l.id),
                eq(schema.listingRevisions.version, l.publishedVersion),
              ),
            )
        : [];
      await recordAudit(tx, null, {
        action: 'listing.expired',
        entityType: 'listing',
        entityId: l.id,
        organizationId: l.organizationId,
        before: { status: 'published' },
        after: { status: 'expired', expiresAt: l.expiresAt?.toISOString() ?? null },
        actorType: 'job',
        correlationId,
      });
      await appendOutbox(tx, {
        eventType: 'listing.expired',
        aggregateType: 'listing',
        aggregateId: l.id,
        organizationId: l.organizationId,
        payload: { listingId: l.id, slug: l.slug, title: rev?.title ?? null },
        correlationId,
      });
    }
    const entry = {
      at: now.toISOString(),
      by: null,
      party: 'system',
      action: 'expired',
      amountKobo: null,
      note: 'The validity date passed without a decision.',
    };
    const offers = await tx
      .update(schema.offers)
      .set({
        status: 'expired',
        decidedAt: now,
        negotiationLog: sql`coalesce(${schema.offers.negotiationLog}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(
        and(
          isNotNull(schema.offers.listingId),
          inArray(schema.offers.status, ['submitted', 'countered']),
          isNotNull(schema.offers.expiresAt),
          lte(schema.offers.expiresAt, now),
        ),
      )
      .returning();
    for (const o of offers) {
      await recordAudit(tx, null, {
        action: 'listing_offer.expired',
        entityType: 'offer',
        entityId: o.id,
        organizationId: o.organizationId,
        after: { status: 'expired' },
        actorType: 'job',
        correlationId,
      });
      await appendOutbox(tx, {
        eventType: 'listing_offer.expired',
        aggregateType: 'offer',
        aggregateId: o.id,
        organizationId: o.organizationId,
        payload: {
          offerId: o.id,
          listingId: o.listingId,
          notifyOrganizationIds: [o.organizationId, o.counterpartyOrganizationId].filter(Boolean),
        },
        correlationId,
      });
    }
    return {
      listingsExpired: expired.length,
      offersExpired: offers.length,
      listingIds: expired.map((l) => l.id),
    };
  });
  if (result.listingsExpired > 0) await invalidatePublicListings();
  return result;
}

/** Staff trigger for the expiry job (rentals.manage or content.publish). */
export async function runListingExpiryNow(
  identity: RequestIdentity,
  options: { correlationId?: string } = {},
): Promise<ListingExpiryRunDto> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const allowed =
    hasStaffPermission(identity.actor, 'rentals.manage') ||
    hasStaffPermission(identity.actor, 'content.publish');
  if (!allowed) throw new ApiError('forbidden', 'needs rentals.manage or content.publish');
  return runListingExpiry(getDb(), { correlationId: options.correlationId });
}
