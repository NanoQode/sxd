import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ApiError, type ListingInquiry } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type ActorContext } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { loadPublicListingFacts } from './public';

/**
 * Public inquiry on a live listing. Creates a CRM lead (source
 * `website_form`) whose `context` carries the listing reference
 * (`kind: 'listing_inquiry'`, listing id, slug, title and published
 * revision), so staff qualify it in the existing leads console. The listing
 * owner sees a count only; contact details stay with SimplexD staff. Abuse
 * controls: per-IP and per-email rate limits in the route, plus the honeypot
 * and too-fast heuristics here, which mark the lead as spam for review
 * instead of rejecting it (the visitor is never told).
 */
export async function createListingInquiry(
  slug: string,
  input: ListingInquiry,
  identity: RequestIdentity | null,
  options: { ipHash: string | null; userAgent: string | null; correlationId: string },
): Promise<{ id: string; status: 'received' }> {
  const listing = await loadPublicListingFacts({ slug });
  if (!listing || !listing.visible) {
    throw new ApiError('not_found', 'this listing is not available for inquiries');
  }
  const suspicious =
    Boolean(input.website) || (input.elapsedMs !== undefined && input.elapsedMs < 1500);
  const ctx: ActorContext = identity?.ctx ?? { userId: null, organizationId: null, staff: false };
  return withActor(getDb(), { ...ctx, correlationId: options.correlationId }, async (tx) => {
    // The seeded land sales/leasing service, or any service on that workflow.
    const [service] = await tx
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(eq(schema.services.workflowTemplateKey, 'land_sales_leasing'))
      .orderBy(sql`case when ${schema.services.slug} = 'land-sales-leasing' then 0 else 1 end`)
      .limit(1);
    // Anonymous rows cannot be read back (RETURNING applies the read policy),
    // so the id is decided here and the row inserted without RETURNING.
    const leadId = randomUUID();
    await tx.insert(schema.leads).values({
      id: leadId,
      userId: identity?.session?.user.id ?? null,
      organizationId: identity?.ctx.organizationId ?? null,
      contactName: input.contactName,
      email: input.email.toLowerCase(),
      phoneE164: input.phoneE164 ?? null,
      source: 'website_form',
      interestServiceId: service?.id ?? null,
      goal: input.interest === 'buy' ? 'buy_safely' : 'other',
      message: input.message,
      context: {
        kind: 'listing_inquiry',
        listingId: listing.id,
        listingSlug: listing.slug,
        listingTitle: listing.title,
        listingKind: listing.kind,
        interest: input.interest,
        elapsedMs: input.elapsedMs ?? null,
        suspicious,
      },
      status: suspicious ? 'spam' : 'new',
      marketingConsent: input.marketingConsent,
      consentPolicyVersion: input.consentPolicyVersion,
      ipHash: options.ipHash,
      userAgent: options.userAgent?.slice(0, 300) ?? null,
    });
    if (input.marketingConsent) {
      await tx.insert(schema.consents).values({
        userId: identity?.session?.user.id ?? null,
        subjectEmail: input.email.toLowerCase(),
        purpose: 'marketing_email',
        granted: true,
        policyVersion: input.consentPolicyVersion,
        source: 'website_form',
        ipHash: options.ipHash,
      });
    }
    await appendOutbox(tx, {
      eventType: 'lead.created',
      aggregateType: 'lead',
      aggregateId: leadId,
      organizationId: identity?.ctx.organizationId ?? null,
      actorUserId: identity?.session?.user.id ?? null,
      payload: { leadId, source: 'website_form', suspicious, listingId: listing.id },
      correlationId: options.correlationId,
    });
    if (!suspicious) {
      // The owner hears that interest arrived, never who it came from.
      await appendOutbox(tx, {
        eventType: 'listing.inquiry_received',
        aggregateType: 'listing',
        aggregateId: listing.id,
        organizationId: listing.organizationId,
        payload: { listingId: listing.id, slug: listing.slug, title: listing.title },
        correlationId: options.correlationId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'lead.created',
      entityType: 'lead',
      entityId: leadId,
      organizationId: identity?.ctx.organizationId ?? null,
      after: { source: 'website_form', suspicious, listingId: listing.id },
      correlationId: options.correlationId,
    });
    return { id: leadId, status: 'received' as const };
  });
}
