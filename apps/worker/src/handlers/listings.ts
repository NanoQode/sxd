import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { appendOutbox, schema, systemContext, withActor } from '@simplexd/db';
import type { JobRunner } from '../runner';

/**
 * Listing jobs. The worker cannot load the web app's server modules
 * (`server-only`, `@/` aliases), so `listings.expire_lapsed` (hourly) runs the
 * same statements as apps/web/src/server/listings/jobs.ts (exercised by the
 * web integration tests and the staff `POST /api/v1/admin/listings/expiry-runs`):
 *  1. published listings whose 90-day availability window passed become
 *     `expired` (audited, owner notified through `listing.expired`);
 *  2. open listing offers past their validity date become `expired`, with an
 *     `expired` entry appended to the negotiation log (`listing_offer.expired`).
 * Both statements only touch rows still in the open state, so re-runs are safe.
 */
export function registerListingHandlers(runner: JobRunner): void {
  runner.register('listings.expire_lapsed', async ({ db, log }) => {
    const now = new Date();
    const correlationId = `listing-expiry:${now.toISOString()}`;
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
        await tx.insert(schema.auditEvents).values({
          actorType: 'job',
          actorUserId: null,
          impersonationId: null,
          organizationId: l.organizationId,
          action: 'listing.expired',
          entityType: 'listing',
          entityId: l.id,
          before: { status: 'published' },
          after: { status: 'expired', expiresAt: l.expiresAt?.toISOString() ?? null },
          reason: null,
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
        await tx.insert(schema.auditEvents).values({
          actorType: 'job',
          actorUserId: null,
          impersonationId: null,
          organizationId: o.organizationId,
          action: 'listing_offer.expired',
          entityType: 'offer',
          entityId: o.id,
          before: null,
          after: { status: 'expired' },
          reason: null,
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
      return { listings: expired.length, offers: offers.length };
    });
    log.info(result, 'listing expiry run');
  });
}
