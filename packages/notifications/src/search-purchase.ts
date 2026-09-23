import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  enqueueJob,
  schema,
  systemContext,
  withActor,
  type Database,
  type DbExecutor,
} from '@simplexd/db';
import {
  matchListing,
  type ListingFacts,
  type SearchCriteria,
  type VerificationCheckFact,
} from '@simplexd/domain/search';
import type { PipelineEnv } from './env';
import { organizationMemberSpecs, staffWithRoles } from './recipients';
import type {
  NotificationChannel,
  NotificationRequest,
  PipelineLogger,
  RecipientSpec,
} from './types';

/**
 * Property search and purchase representation (build brief §8):
 *
 *  - `loadSearchableListings`: the publicly visible listings (the published
 *    revision; a listing under review for changes stays live on its approved
 *    revision; duplicates and lapsed availability windows excluded — the same
 *    rule as apps/web/src/server/listings/rules.ts `isPubliclyVisible`) with
 *    the facts the saved-search matcher reads. Shared by the web preview and
 *    the alert job so both agree on what "matches" means.
 *  - `runSavedSearchAlerts`: the scheduled job body. For each alert-enabled
 *    saved search it examines listings published since the search's
 *    watermark (`last_run_at`, minus an overlap window so a listing whose
 *    publication committed late is not missed), and for each new match
 *    enqueues one `notifications.dispatch` job keyed
 *    `saved-search-alert:<search>:<listing>`. That job dedupe key is the
 *    ledger: a listing is alerted at most once per saved search, however
 *    often the job runs or overlaps.
 *  - `searchPurchaseResolvers`: notification resolvers for the events the
 *    search and purchase services emit (in-app + email via the existing
 *    `activity_update` template).
 */

export const SAVED_SEARCH_ALERT_JOB = 'search.saved_search_alerts';
/** Re-examine this much time before the watermark (late-committing publications). */
export const SAVED_SEARCH_ALERT_OVERLAP_MS = 60 * 60_000;
/** Per-run cap per search; the rest are picked up by the next run (the watermark is not advanced past them). */
export const SAVED_SEARCH_ALERT_MAX_PER_RUN = 25;

export function savedSearchAlertKey(savedSearchId: string, listingId: string): string {
  return `saved-search-alert:${savedSearchId}:${listingId}`;
}

export interface SearchableListing extends ListingFacts {
  slug: string;
  organizationId: string;
  priceBasis: string | null;
  currency: string;
  areaM2Text: string | null;
  availability: string | null;
  verificationSummary: string | null;
  publicLocationPrecision: string | null;
  marketName: string | null;
  stateName: string | null;
  publishedAt: Date | null;
}

function checksOf(scope: unknown): { checks: VerificationCheckFact[]; summary: string | null } {
  if (!scope || typeof scope !== 'object') return { checks: [], summary: null };
  const s = scope as { checks?: unknown; summary?: unknown };
  const checks = Array.isArray(s.checks)
    ? s.checks.flatMap((c): VerificationCheckFact[] => {
        if (!c || typeof c !== 'object') return [];
        const o = c as Record<string, unknown>;
        if (typeof o['item'] !== 'string') return [];
        const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
        return [
          {
            item: o['item'] as string,
            outcome: text('outcome'),
            result: text('result'),
            checkedBy: text('checkedBy'),
            checkedAt: text('checkedAt'),
            expiresAt: text('expiresAt'),
          },
        ];
      })
    : [];
  return { checks, summary: typeof s.summary === 'string' ? s.summary : null };
}

/**
 * Publicly visible listings with the facts search and comparison use. Runs
 * under whatever context the caller holds; the web layer calls it under the
 * system context because the owning property row is not public (only
 * public-safe fields are returned: never the address or the owner).
 */
export async function loadSearchableListings(
  tx: DbExecutor,
  opts: {
    now?: Date;
    publishedAfter?: Date;
    publishedUpTo?: Date;
    listingIds?: string[];
    /** Include listings that are no longer publicly visible (shortlist history). */
    includeHidden?: boolean;
    limit?: number;
  } = {},
): Promise<Array<SearchableListing & { visible: boolean }>> {
  const now = opts.now ?? new Date();
  if (opts.listingIds && opts.listingIds.length === 0) return [];
  const visible = and(
    or(eq(schema.listings.status, 'published'), eq(schema.listings.status, 'in_moderation')),
    isNotNull(schema.listings.publishedVersion),
    isNull(schema.listings.duplicateOfListingId),
    or(isNull(schema.listings.expiresAt), gt(schema.listings.expiresAt, now)),
  )!;
  const rows = await tx
    .select({
      listing: schema.listings,
      revision: schema.listingRevisions,
      propertyKind: schema.properties.kind,
      marketId: schema.properties.marketId,
      marketName: schema.markets.name,
      stateId: schema.markets.stateId,
      stateName: schema.states.name,
      visible: sql<boolean>`${visible}`,
    })
    .from(schema.listings)
    .innerJoin(
      schema.listingRevisions,
      and(
        eq(schema.listingRevisions.listingId, schema.listings.id),
        eq(schema.listingRevisions.version, sql`${schema.listings.publishedVersion}`),
      ),
    )
    .innerJoin(schema.properties, eq(schema.properties.id, schema.listings.propertyId))
    .leftJoin(schema.markets, eq(schema.markets.id, schema.properties.marketId))
    .leftJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
    .where(
      and(
        opts.includeHidden ? undefined : visible,
        opts.listingIds ? inArray(schema.listings.id, opts.listingIds) : undefined,
        opts.publishedAfter ? gt(schema.listings.publishedAt, opts.publishedAfter) : undefined,
        opts.publishedUpTo ? lte(schema.listings.publishedAt, opts.publishedUpTo) : undefined,
      ),
    )
    .orderBy(asc(schema.listings.publishedAt), asc(schema.listings.id))
    .limit(opts.limit ?? 2000);
  return rows.map((r) => {
    const scope = checksOf(r.revision.verificationScope);
    const area = r.revision.areaM2 === null ? null : Number(r.revision.areaM2);
    return {
      id: r.listing.id,
      slug: r.listing.slug,
      organizationId: r.listing.organizationId,
      kind: r.listing.kind,
      propertyKind: r.propertyKind,
      title: r.revision.title,
      priceKobo: r.revision.priceKobo,
      priceBasis: r.revision.priceBasis,
      currency: r.revision.currency,
      areaM2: area !== null && Number.isFinite(area) ? area : null,
      areaM2Text: r.revision.areaM2,
      marketId: r.marketId,
      stateId: r.stateId,
      tenure: r.revision.tenure,
      titleDisclosure: r.revision.titleDisclosure,
      verificationChecks: scope.checks,
      verificationSummary: scope.summary,
      availability: r.revision.availability,
      publicLocationPrecision: r.revision.publicLocationPrecision,
      marketName: r.marketName,
      stateName: r.stateName,
      publishedAt: r.listing.publishedAt,
      visible: Boolean(r.visible),
    };
  });
}

export interface SavedSearchAlertRunResult {
  searches: number;
  evaluated: number;
  alerted: number;
  alreadyAlerted: number;
}

/** Stored criteria are validated on write; reads stay defensive. */
function criteriaOf(raw: unknown): SearchCriteria {
  return raw && typeof raw === 'object' ? (raw as SearchCriteria) : {};
}

/**
 * Scheduled alert run (idempotent per saved search × listing). Each saved
 * search runs in its own transaction under the system context, so one
 * failing search never holds back the rest.
 */
export async function runSavedSearchAlerts(
  db: Database,
  opts: { now?: Date; log?: PipelineLogger; savedSearchIds?: string[] } = {},
): Promise<SavedSearchAlertRunResult> {
  const now = opts.now ?? new Date();
  const result: SavedSearchAlertRunResult = {
    searches: 0,
    evaluated: 0,
    alerted: 0,
    alreadyAlerted: 0,
  };
  const searches = await withActor(db, systemContext('saved-search-alerts'), (tx) =>
    tx
      .select()
      .from(schema.savedSearches)
      .where(
        and(
          eq(schema.savedSearches.alertsEnabled, true),
          opts.savedSearchIds ? inArray(schema.savedSearches.id, opts.savedSearchIds) : undefined,
        ),
      )
      .orderBy(asc(schema.savedSearches.createdAt)),
  );
  if (opts.savedSearchIds && opts.savedSearchIds.length === 0) return result;
  for (const search of searches) {
    try {
      await withActor(db, systemContext('saved-search-alerts'), async (tx) => {
        const watermark = search.lastRunAt ?? search.createdAt;
        const since = new Date(watermark.getTime() - SAVED_SEARCH_ALERT_OVERLAP_MS);
        const candidates = await loadSearchableListings(tx, {
          now,
          publishedAfter: since,
          publishedUpTo: now,
        });
        const criteria = criteriaOf(search.criteria);
        let alertedHere = 0;
        let nextWatermark = now;
        for (const listing of candidates) {
          result.evaluated += 1;
          // The owner's own listings never alert them.
          if (search.organizationId && listing.organizationId === search.organizationId) continue;
          if (!matchListing(criteria, listing, now).matches) continue;
          if (alertedHere >= SAVED_SEARCH_ALERT_MAX_PER_RUN) {
            // Leave the rest for the next run: do not move the watermark past them.
            if (listing.publishedAt && listing.publishedAt < nextWatermark) {
              nextWatermark = listing.publishedAt;
            }
            continue;
          }
          const key = savedSearchAlertKey(search.id, listing.id);
          const enq = await enqueueJob(tx, {
            type: 'notifications.dispatch',
            queue: 'notifications',
            organizationId: search.organizationId,
            actorUserId: null,
            dedupeKey: key,
            correlationId: key,
            payload: {
              event: {
                id: key,
                type: 'saved_search.matched',
                aggregateType: 'saved_search',
                aggregateId: search.id,
                payload: {
                  savedSearchId: search.id,
                  searchName: search.name,
                  listingId: listing.id,
                  listingSlug: listing.slug,
                  listingTitle: listing.title,
                  recipientUserIds: [search.userId],
                },
              },
            },
          });
          if (enq.deduplicated) result.alreadyAlerted += 1;
          else {
            result.alerted += 1;
            alertedHere += 1;
          }
        }
        // Advancing the watermark keeps the owner's concurrency token
        // (`updated_at`) unchanged: the job is not an edit of the search.
        await tx
          .update(schema.savedSearches)
          .set({ lastRunAt: nextWatermark, updatedAt: sql`${schema.savedSearches.updatedAt}` })
          .where(
            and(
              eq(schema.savedSearches.id, search.id),
              eq(schema.savedSearches.alertsEnabled, true),
            ),
          );
      });
      result.searches += 1;
    } catch (err) {
      opts.log?.error(
        { err: err instanceof Error ? err.message : String(err), savedSearchId: search.id },
        'saved search alert run failed',
      );
    }
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/* Notification resolvers                                                  */
/* ---------------------------------------------------------------------- */

interface EventLike {
  id: number | string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  organizationId?: string | null;
  correlationId?: string | null;
}

interface ResolverContext {
  tx: DbExecutor;
  event: EventLike;
  payload: Record<string, unknown>;
  env: PipelineEnv;
  scope: string;
}

type Resolver = (ctx: ResolverContext) => Promise<NotificationRequest[]>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const isUuid = (v: string | null | undefined): v is string =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const label = (s: string | null) => (s ?? 'updated').replace(/_/g, ' ');

const CUSTOMER_ROLES = ['owner', 'approver', 'member'];
const EMAIL_APP: NotificationChannel[] = ['email', 'in_app'];

function update(opts: {
  entityType: string;
  title: (p: Record<string, unknown>) => string;
  message: (p: Record<string, unknown>) => string;
  link: (p: Record<string, unknown>, e: EventLike) => string;
  /** Notify the customer organisation's members named on the event. */
  customerMembers?: boolean;
  staffRoles?: Array<(typeof schema.staffRoleEnum.enumValues)[number]>;
  channels?: NotificationChannel[];
  dedupeScope?: (p: Record<string, unknown>, scope: string) => string;
}): Resolver {
  return async ({ tx, event, payload, env, scope }) => {
    const recipients: RecipientSpec[] = strings(payload['recipientUserIds']).map((userId) => ({
      userId,
    }));
    if (opts.customerMembers && event.organizationId) {
      recipients.push(...(await organizationMemberSpecs(tx, event.organizationId, CUSTOMER_ROLES)));
    }
    if (opts.staffRoles) recipients.push(...(await staffWithRoles(tx, opts.staffRoles)));
    const exclude = new Set(strings(payload['excludeUserIds']));
    const seen = new Set<string>();
    const unique = recipients.filter((r) => {
      const key = r.userId ?? r.email ?? '';
      if (!key || seen.has(key) || (r.userId && exclude.has(r.userId))) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0) return [];
    const linkPath = opts.link(payload, event);
    return [
      {
        templateKey: 'activity_update',
        category: 'transactional',
        channels: opts.channels ?? EMAIL_APP,
        recipients: unique,
        variables: {
          title: opts.title(payload),
          message: opts.message(payload),
          linkUrl: `${env.appUrl}${linkPath}`,
        },
        dedupeScope: opts.dedupeScope ? opts.dedupeScope(payload, scope) : scope,
        inApp: { linkPath },
        relatedEntity: {
          type: opts.entityType,
          id: isUuid(event.aggregateId) ? event.aggregateId : null,
        },
        organizationId: event.organizationId ?? null,
        correlationId: event.correlationId ?? null,
      },
    ];
  };
}

const requestLink = (tab: 'search' | 'purchase') => (p: Record<string, unknown>) =>
  str(p['serviceRequestId'])
    ? `/portal/requests/${str(p['serviceRequestId'])}?tab=${tab}`
    : '/portal/requests';
const adminRequestLink = (p: Record<string, unknown>) =>
  str(p['serviceRequestId'])
    ? `/admin/service-requests/${str(p['serviceRequestId'])}`
    : '/admin/service-requests';

export const searchPurchaseResolvers: Record<string, Resolver> = {
  'saved_search.matched': update({
    entityType: 'saved_search',
    title: (p) => `New listing for “${str(p['searchName']) ?? 'your saved search'}”`,
    message: (p) =>
      `${str(p['listingTitle']) ?? 'A listing'} was published and matches your saved search. Open it to see what the listing discloses and what was verified.`,
    link: (p) => (str(p['listingSlug']) ? `/properties/${str(p['listingSlug'])}` : '/properties'),
    dedupeScope: (p, scope) =>
      str(p['savedSearchId']) && str(p['listingId'])
        ? savedSearchAlertKey(str(p['savedSearchId'])!, str(p['listingId'])!)
        : scope,
  }),
  'shortlist.shared': update({
    entityType: 'shortlist',
    customerMembers: true,
    title: () => 'Your shortlist is ready',
    message: (p) =>
      `The team shared “${str(p['name']) ?? 'a shortlist'}”. Compare the properties side by side, rate them and ask for viewings.`,
    link: requestLink('search'),
  }),
  'shortlist.accepted': update({
    entityType: 'shortlist',
    title: () => 'Shortlist accepted',
    message: (p) =>
      `The customer accepted the shortlist “${str(p['name']) ?? ''}”. The search engagement can move to delivery.`,
    link: adminRequestLink,
    channels: ['in_app', 'email'],
  }),
  'shortlist.outcome_recorded': update({
    entityType: 'shortlist',
    customerMembers: true,
    title: () => 'Search outcome recorded',
    message: (p) =>
      `The team recorded the outcome of your property search: ${label(str(p['outcome']))}. Read the summary on your request.`,
    link: requestLink('search'),
  }),
  'viewing.requested': update({
    entityType: 'viewing',
    title: () => 'Viewing requested',
    message: (p) =>
      `The customer asked to view ${str(p['title']) ?? 'a shortlisted property'}. Confirm a time or book the appointment.`,
    link: adminRequestLink,
    channels: ['in_app', 'email'],
  }),
  'viewing.updated': update({
    entityType: 'viewing',
    title: (p) => `Viewing ${label(str(p['status']))}`,
    message: (p) =>
      `Your viewing of ${str(p['title']) ?? 'the property'} is now ${label(str(p['status']))}.${str(p['status']) === 'completed' ? ' Tell the team what you thought.' : ''}`,
    link: requestLink('search'),
  }),
  'purchase_offer.updated': update({
    entityType: 'offer',
    customerMembers: true,
    title: (p) => `Offer ${label(str(p['status']))}`,
    message: (p) =>
      `The offer on ${str(p['subjectTitle']) ?? 'the property'} is now ${label(str(p['status']))}. The negotiation log on your request shows every step.`,
    link: requestLink('purchase'),
  }),
  'purchase_item.created': update({
    entityType: 'engagement_item',
    customerMembers: true,
    title: (p) => `New ${label(str(p['kind']))}: ${str(p['title']) ?? ''}`.trim(),
    message: (p) =>
      `The team added a ${label(str(p['kind']))} to your purchase: ${str(p['title']) ?? ''}.`,
    link: requestLink('purchase'),
  }),
  'purchase_handover.ready': update({
    entityType: 'engagement_item',
    customerMembers: true,
    title: () => 'Documents ready for handover',
    message: (p) =>
      `${str(p['title']) ?? 'A document'} is ready. Review it and acknowledge receipt on your request.`,
    link: requestLink('purchase'),
  }),
  'purchase_handover.acknowledged': update({
    entityType: 'engagement_item',
    title: () => 'Handover acknowledged',
    message: (p) => `The customer acknowledged receipt of ${str(p['title']) ?? 'a document'}.`,
    link: adminRequestLink,
    channels: ['in_app'],
  }),
  'purchase_closing.submitted': update({
    entityType: 'service_request',
    staffRoles: ['operations_manager'],
    title: () => 'Closing pack awaiting approval',
    message: (p) =>
      `The closing pack for ${str(p['reference']) ?? 'a purchase'} was submitted. A different reviewer must approve it.`,
    link: adminRequestLink,
    channels: ['in_app', 'email'],
  }),
};
