import 'server-only';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { NO_TENDER_OPPORTUNITIES, type TenderOpportunitiesDto } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { authorizeStaff } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { demote, elevate } from '@/server/portal/elevate';
import { TENDERING_FEATURE } from '@/server/tenders/shared';

/**
 * Tender opportunities for the location panel (brief §6.2). Tenders carry no
 * market of their own: they link through `projects.marketId`, the project's
 * property (`properties.marketId`) or the service request
 * (`service_requests.marketId`). Only open, published tenders whose deadline
 * is still ahead on the database clock count.
 *
 * Tenders are never public. The existing visibility rules apply: staff with
 * `tenders.manage` or `bids.evaluate` see every tender, an invited partner the
 * ones they were invited to (not declined), a customer their organisation's.
 * Anonymous visitors get an empty, honestly labelled result without a query.
 *
 * Two steps: the tenders the caller may see are read under the caller's own
 * row-level security context (which proves access), then only those tenders'
 * market links are resolved with the policy bypass, because an invited partner
 * cannot read the customer's project row itself. The elevated read discloses
 * nothing beyond "this tender concerns this market" for tenders the caller
 * already sees, and the context is restored immediately afterwards.
 */

const OPEN_STATUSES = ['published', 'clarifications'] as const;
const CANDIDATE_LIMIT = 500;
const LIMIT = 10;

type Scope = TenderOpportunitiesDto['scope'];
type LinkedThrough = TenderOpportunitiesDto['items'][number]['linkedThrough'];

export function tenderScopeFor(identity: RequestIdentity): Scope {
  if (!identity.session) return 'none';
  if (
    authorizeStaff(identity.actor, 'tenders.manage').allowed ||
    authorizeStaff(identity.actor, 'bids.evaluate').allowed
  ) {
    return 'staff';
  }
  if (identity.actor.isPartner) return 'partner';
  if (identity.ctx.organizationId) return 'customer';
  return 'none';
}

function hrefFor(scope: Scope, tenderId: string): string | null {
  switch (scope) {
    case 'staff':
      return `/admin/tenders/${tenderId}`;
    case 'partner':
      return `/partner/tenders/${tenderId}`;
    default:
      return null;
  }
}

function openConditions(): SQL[] {
  const t = schema.tenders;
  return [
    inArray(t.status, [...OPEN_STATUSES]),
    gt(t.submissionDeadlineAt, sql`now()`),
    or(isNull(t.releaseAt), lte(t.releaseAt, sql`now()`)) as SQL,
  ];
}

export async function loadTenderOpportunities(
  tx: Transaction,
  identity: RequestIdentity,
  marketId: string,
): Promise<TenderOpportunitiesDto> {
  if (identity.featureFlags[TENDERING_FEATURE] !== true) return NO_TENDER_OPPORTUNITIES;
  const scope = tenderScopeFor(identity);
  if (scope === 'none') return { moduleEnabled: true, scope, items: [] };

  const t = schema.tenders;
  const columns = {
    id: t.id,
    reference: t.reference,
    title: t.title,
    status: t.status,
    releaseAt: t.releaseAt,
    submissionDeadlineAt: t.submissionDeadlineAt,
    displayTimeZone: t.displayTimeZone,
  };

  // Step 1: open tenders the caller may see, under the caller's own context.
  const visible =
    scope === 'partner'
      ? await tx
          .select(columns)
          .from(t)
          .innerJoin(
            schema.tenderInvitations,
            and(
              eq(schema.tenderInvitations.tenderId, t.id),
              eq(schema.tenderInvitations.partnerUserId, identity.ctx.userId as string),
              sql`${schema.tenderInvitations.status} <> 'declined'`,
            ),
          )
          .where(and(...openConditions()))
          .orderBy(asc(t.submissionDeadlineAt), asc(t.id))
          .limit(CANDIDATE_LIMIT)
      : await tx
          .select(columns)
          .from(t)
          .where(
            and(
              ...openConditions(),
              scope === 'customer'
                ? eq(t.organizationId, identity.ctx.organizationId as string)
                : undefined,
            ),
          )
          .orderBy(asc(t.submissionDeadlineAt), asc(t.id))
          .limit(CANDIDATE_LIMIT);
  if (visible.length === 0) return { moduleEnabled: true, scope, items: [] };

  // Step 2: which of those concern this market (elevated; see the module note).
  const ids = visible.map((row) => row.id);
  let links: Array<{
    id: string;
    projectMarketId: string | null;
    propertyMarketId: string | null;
    serviceRequestMarketId: string | null;
  }>;
  await elevate(tx, identity.ctx);
  try {
    links = await tx
      .select({
        id: t.id,
        projectMarketId: schema.projects.marketId,
        propertyMarketId: schema.properties.marketId,
        serviceRequestMarketId: schema.serviceRequests.marketId,
      })
      .from(t)
      .leftJoin(schema.projects, eq(schema.projects.id, t.projectId))
      .leftJoin(schema.properties, eq(schema.properties.id, schema.projects.propertyId))
      .leftJoin(schema.serviceRequests, eq(schema.serviceRequests.id, t.serviceRequestId))
      .where(
        and(
          inArray(t.id, ids),
          or(
            eq(schema.projects.marketId, marketId),
            eq(schema.properties.marketId, marketId),
            eq(schema.serviceRequests.marketId, marketId),
          ),
        ),
      );
  } finally {
    await demote(tx, identity.ctx);
  }
  const linkedThroughById = new Map<string, LinkedThrough>(
    links.map((link) => [
      link.id,
      link.projectMarketId === marketId
        ? 'project'
        : link.propertyMarketId === marketId
          ? 'property'
          : 'service_request',
    ]),
  );

  return {
    moduleEnabled: true,
    scope,
    items: visible.flatMap((row) => {
      const linkedThrough = linkedThroughById.get(row.id);
      if (
        !linkedThrough ||
        !row.submissionDeadlineAt ||
        (row.status !== 'published' && row.status !== 'clarifications')
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          reference: row.reference,
          title: row.title,
          status: row.status,
          releaseAt: row.releaseAt ? row.releaseAt.toISOString() : null,
          submissionDeadlineAt: row.submissionDeadlineAt.toISOString(),
          displayTimeZone: row.displayTimeZone,
          linkedThrough,
          href: hrefFor(scope, row.id),
        },
      ];
    }).slice(0, LIMIT),
  };
}
