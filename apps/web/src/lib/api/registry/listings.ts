import { z } from 'zod';
import {
  leaseMilestoneCreateSchema,
  leaseMilestoneUpdateSchema,
  listingApproveSchema,
  listingCreateSchema,
  listingDetailDtoSchema,
  listingExpiryRunDtoSchema,
  listingInquirySchema,
  listingListQuerySchema,
  listingMarkDuplicateSchema,
  listingOfferActionSchema,
  listingOfferCreateSchema,
  listingOfferDtoSchema,
  listingOfferListQuerySchema,
  listingOutcomeSchema,
  listingReasonSchema,
  listingSummaryDtoSchema,
  listingTransactionDtoSchema,
  listingUpdateSchema,
  listingVersionOnlySchema,
  listRoutes,
  publicListingDtoSchema,
  publicListingFiltersSchema,
  publicListingMediaQuerySchema,
  registerRoute,
  slugSchema,
  uuidSchema,
  verificationCheckCreateSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for listings, moderation, public search, inquiries,
 * offers and land transaction tracking. Route handlers import this module
 * for its side effect; registration is idempotent for hot reloads.
 */

const idParams = z.object({ id: uuidSchema });
const slugParams = z.object({ slug: slugSchema });
const items = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });
const notFound = { 404: { description: 'Not visible to the caller' } };
const conflict = { 409: { description: 'version_conflict or invalid_transition' } };

function register(spec: RouteSpec): void {
  if (listRoutes().some((r) => r.operationId === spec.operationId)) return;
  registerRoute(spec);
}

const publicListingStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('published'), listing: publicListingDtoSchema }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum(['expired', 'duplicate', 'withdrawn', 'closed']),
    title: z.string(),
    kind: z.string(),
    canonicalSlug: z.string().nullable(),
  }),
]);

const specs: RouteSpec[] = [
  /* Owner listings */
  {
    method: 'get',
    path: '/api/v1/listings',
    summary: 'List listings',
    description:
      'Customers see their active organisation (org.read); staff with content.publish, rentals.manage or customers.read see all. `queue=moderation` returns listings awaiting a decision, oldest first.',
    tags: ['listings'],
    operationId: 'listListings',
    auth: 'session',
    request: { query: listingListQuerySchema },
    responses: { 200: { description: 'Listings', body: items(listingSummaryDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/listings',
    summary: 'Create a draft listing',
    description:
      'org.listings.manage in the property organisation. Revision 1 is created from the content; prices are optional (never invented), media must be clean images of the organisation and the public location precision defaults to market (exact coordinates need staff approval at publication).',
    tags: ['listings'],
    operationId: 'createListing',
    auth: 'session',
    request: { body: listingCreateSchema },
    responses: { 201: { description: 'Draft listing', body: listingDetailDtoSchema }, ...notFound },
  },
  {
    method: 'get',
    path: '/api/v1/listings/{id}',
    summary: 'Read a listing with its current and published revisions',
    tags: ['listings'],
    operationId: 'getListing',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...notFound },
  },
  {
    method: 'patch',
    path: '/api/v1/listings/{id}',
    summary: 'Save a new revision',
    description:
      'Every save creates listing revision currentVersion+1; expectedVersion guards concurrent edits. Verification checks recorded by staff are carried forward. A published listing stays live on its approved revision until the new one is submitted and approved.',
    tags: ['listings'],
    operationId: 'reviseListing',
    auth: 'session',
    request: { params: idParams, body: listingUpdateSchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/listings/{id}/submit',
    summary: 'Submit for moderation',
    description:
      'Requires a verified, unexpired owner authority for the property (422 insufficient_evidence otherwise). Allowed from draft, rejected, expired, and from published when newer changes exist.',
    tags: ['listings'],
    operationId: 'submitListing',
    auth: 'session',
    request: { params: idParams, body: listingVersionOnlySchema },
    responses: {
      200: { description: 'Listing in moderation', body: listingDetailDtoSchema },
      422: { description: 'insufficient_evidence: owner authority required' },
      ...conflict,
      ...notFound,
    },
  },
  {
    method: 'post',
    path: '/api/v1/listings/{id}/withdraw',
    summary: 'Withdraw a listing (drafts are archived)',
    tags: ['listings'],
    operationId: 'withdrawListing',
    auth: 'session',
    request: { params: idParams, body: listingReasonSchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/listings/{id}/confirm-availability',
    summary: 'Re-confirm availability of a live listing',
    description: 'Stamps availabilityConfirmedAt and restarts the 90-day window. Expired listings are re-submitted for moderation instead.',
    tags: ['listings'],
    operationId: 'confirmListingAvailability',
    auth: 'session',
    request: { params: idParams, body: listingVersionOnlySchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...conflict, ...notFound },
  },
  /* Offers */
  {
    method: 'get',
    path: '/api/v1/listings/{id}/offers',
    summary: 'Offers on a listing',
    description: 'The owner organisation and staff see every offer; a buyer organisation sees its own.',
    tags: ['listing-offers'],
    operationId: 'listListingOffers',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'Offers', body: items(listingOfferDtoSchema) }, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/listings/{id}/offers',
    summary: 'Make an offer on a live sale or lease listing',
    description:
      'org.requests.create in the buyer organisation. The offer belongs to the buyer organisation with the listing owner as counterparty; the first negotiation-log entry is written with it.',
    tags: ['listing-offers'],
    operationId: 'createListingOffer',
    auth: 'session',
    request: { params: idParams, body: listingOfferCreateSchema },
    responses: { 201: { description: 'Offer', body: listingOfferDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'get',
    path: '/api/v1/listing-offers',
    summary: 'The active organisation’s listing offers (buyer and owner sides)',
    tags: ['listing-offers'],
    operationId: 'listMyListingOffers',
    auth: 'session',
    request: { query: listingOfferListQuerySchema },
    responses: { 200: { description: 'Offers', body: items(listingOfferDtoSchema) } },
  },
  {
    method: 'get',
    path: '/api/v1/listing-offers/{id}',
    summary: 'Read an offer with its negotiation log',
    tags: ['listing-offers'],
    operationId: 'getListingOffer',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'Offer', body: listingOfferDtoSchema }, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/listing-offers/{id}/actions',
    summary: 'Counter, accept, reject or withdraw',
    description:
      'The side whose turn it is decides (submitted: owner counters/accepts/rejects, buyer withdraws; countered: buyer counters/accepts/withdraws, owner rejects). expectedEntries must equal the current log length. The log is append-only.',
    tags: ['listing-offers'],
    operationId: 'actOnListingOffer',
    auth: 'session',
    request: { params: idParams, body: listingOfferActionSchema },
    responses: { 200: { description: 'Offer', body: listingOfferDtoSchema }, ...conflict, ...notFound },
  },
  /* Transaction tracking */
  {
    method: 'get',
    path: '/api/v1/listings/{id}/transaction',
    summary: 'Land transaction: linked request, milestones, outcome, accepted offer',
    tags: ['listings'],
    operationId: 'getListingTransaction',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'Transaction', body: listingTransactionDtoSchema }, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/listings/{id}/lease-milestones',
    summary: 'Add a lease/closing milestone',
    description:
      'org.listings.manage or staff rentals.manage. The first item names the land sales/leasing service request that represents the transaction; later items must use the same one. Stored as engagement_items (lease_milestone for leases, closing_task for sales).',
    tags: ['listings'],
    operationId: 'addLeaseMilestone',
    auth: 'session',
    request: { params: idParams, body: leaseMilestoneCreateSchema },
    responses: { 201: { description: 'Transaction', body: listingTransactionDtoSchema }, ...notFound },
  },
  {
    method: 'patch',
    path: '/api/v1/listings/{id}/lease-milestones/{itemId}',
    summary: 'Move a milestone (open, in progress, satisfied, waived, failed, cancelled)',
    tags: ['listings'],
    operationId: 'updateLeaseMilestone',
    auth: 'session',
    request: { params: z.object({ id: uuidSchema, itemId: uuidSchema }), body: leaseMilestoneUpdateSchema },
    responses: { 200: { description: 'Transaction', body: listingTransactionDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/listings/{id}/outcome',
    summary: 'Record the documented outcome (sold, leased, withdrawn)',
    description:
      'Sold and leased need evidence files and the transaction request and close the listing (archived); withdrawn moves it to withdrawn. Records a satisfied closing_task with the evidence and links the accepted offer when named.',
    tags: ['listings'],
    operationId: 'recordListingOutcome',
    auth: 'session',
    request: { params: idParams, body: listingOutcomeSchema },
    responses: { 201: { description: 'Transaction', body: listingTransactionDtoSchema }, ...conflict, ...notFound },
  },
  /* Moderation */
  {
    method: 'get',
    path: '/api/v1/admin/listings',
    summary: 'Moderation queue and all listings (staff)',
    tags: ['admin-listings'],
    operationId: 'adminListListings',
    auth: 'staff',
    request: { query: listingListQuerySchema },
    responses: { 200: { description: 'Listings', body: items(listingSummaryDtoSchema) } },
  },
  {
    method: 'post',
    path: '/api/v1/admin/listings/{id}/approve',
    summary: 'Publish a specific revision (content.publish)',
    description:
      'The revision must be the current one; the owner authority is re-checked; exact coordinates need approveExactLocation. Sets publishedVersion, publishedAt, expiresAt (90-day window) and availabilityConfirmedAt, records the owner-authority check on the verification scope, audits and notifies the owner.',
    tags: ['admin-listings'],
    operationId: 'approveListing',
    auth: 'staff',
    request: { params: idParams, body: listingApproveSchema },
    responses: {
      200: { description: 'Published listing', body: listingDetailDtoSchema },
      422: { description: 'insufficient_evidence: owner authority lapsed' },
      ...conflict,
      ...notFound,
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/listings/{id}/reject',
    summary: 'Reject with a reason (content.publish)',
    description: 'A never-published listing becomes rejected; a live listing keeps its approved revision and returns to published.',
    tags: ['admin-listings'],
    operationId: 'rejectListing',
    auth: 'staff',
    request: { params: idParams, body: listingReasonSchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/admin/listings/{id}/request-changes',
    summary: 'Request changes with a reason (content.publish)',
    tags: ['admin-listings'],
    operationId: 'requestListingChanges',
    auth: 'staff',
    request: { params: idParams, body: listingReasonSchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/admin/listings/{id}/mark-duplicate',
    summary: 'Mark as a duplicate of another listing (content.publish)',
    description: 'Duplicates never show publicly and cannot be resubmitted; the public URL points to the original while it is live.',
    tags: ['admin-listings'],
    operationId: 'markListingDuplicate',
    auth: 'staff',
    request: { params: idParams, body: listingMarkDuplicateSchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...conflict, ...notFound },
  },
  {
    method: 'post',
    path: '/api/v1/admin/listings/{id}/verification-checks',
    summary: 'Record a verification check (rentals.manage)',
    description:
      'Appends what was checked, the outcome, by whom, when and until when to the current revision (and the published one when different). Checks are never rewritten.',
    tags: ['admin-listings'],
    operationId: 'recordListingVerificationCheck',
    auth: 'staff',
    request: { params: idParams, body: verificationCheckCreateSchema },
    responses: { 200: { description: 'Listing', body: listingDetailDtoSchema }, ...notFound },
  },
  {
    method: 'get',
    path: '/api/v1/admin/listings/{id}/inquiries',
    summary: 'Inquiries raised from a listing (leads.read)',
    tags: ['admin-listings'],
    operationId: 'listListingInquiries',
    auth: 'staff',
    request: { params: idParams },
    responses: {
      200: {
        description: 'Leads',
        body: items(
          z.object({
            id: uuidSchema,
            contactName: z.string(),
            status: z.string(),
            createdAt: z.string(),
            suspicious: z.boolean(),
          }),
        ),
      },
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/listings/expiry-runs',
    summary: 'Run the listing and offer expiry job now (rentals.manage or content.publish)',
    tags: ['admin-listings'],
    operationId: 'runListingExpiry',
    auth: 'staff',
    responses: { 201: { description: 'Run summary', body: listingExpiryRunDtoSchema } },
  },
  /* Public */
  {
    method: 'get',
    path: '/api/v1/public/listings',
    summary: 'Search published listings',
    description:
      'Only published, non-duplicate listings inside their availability window, at the approved location precision. Unknown filter values are ignored and reported in ignoredParams.',
    tags: ['public', 'listings'],
    operationId: 'searchPublicListings',
    auth: 'public',
    request: { query: publicListingFiltersSchema.partial() },
    responses: {
      200: {
        description: 'Listings',
        body: z.object({
          items: z.array(publicListingDtoSchema),
          filters: publicListingFiltersSchema,
          ignoredParams: z.array(z.string()),
        }),
      },
    },
  },
  {
    method: 'get',
    path: '/api/v1/public/listings/{slug}',
    summary: 'Read a published listing, or why it is no longer available (410)',
    tags: ['public', 'listings'],
    operationId: 'getPublicListing',
    auth: 'public',
    request: { params: slugParams },
    responses: {
      200: { description: 'Live listing', body: publicListingStateSchema },
      410: { description: 'No longer available (expired, duplicate, withdrawn or closed)', body: publicListingStateSchema },
      404: { description: 'Unknown or never published' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/public/listings/{slug}/inquiries',
    summary: 'Ask about a listing',
    description:
      'Creates a CRM lead carrying the listing reference. Rate limited (5/hour per IP, 3/hour per email); honeypot and too-fast submissions are marked for review without telling the visitor. The owner sees a count only.',
    tags: ['public', 'listings'],
    operationId: 'createListingInquiry',
    auth: 'public',
    request: { params: slugParams, body: listingInquirySchema },
    responses: {
      201: { description: 'Received', body: z.object({ id: uuidSchema, status: z.literal('received') }) },
      404: { description: 'Listing not open to inquiries' },
      429: { description: 'rate_limited' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/public/listings/{slug}/media/{fileId}',
    summary: 'Redirect to a publicly approved photo derivative',
    description: 'Only clean, publicly approved images on the published revision; originals are never served.',
    tags: ['public', 'listings'],
    operationId: 'getPublicListingMedia',
    auth: 'public',
    request: { params: z.object({ slug: slugSchema, fileId: uuidSchema }), query: publicListingMediaQuerySchema },
    responses: {
      302: { description: 'Signed derivative URL' },
      200: {
        description: 'Signed URL (Accept: application/json)',
        body: z.object({ url: z.string(), expiresAt: z.string(), contentType: z.string() }),
      },
      404: { description: 'Not available' },
    },
  },
];

for (const spec of specs) register(spec);

export const listingRouteSpecs: readonly RouteSpec[] = specs;
