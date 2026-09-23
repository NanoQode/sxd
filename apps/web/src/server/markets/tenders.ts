import 'server-only';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { NO_TENDER_OPPORTUNITIES, type TenderOpportunitiesDto } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { authorizeStaff } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
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
 * Anonymous visitors get an empty, honestly labelled result without a query;
 * row-level security remains the second net behind these checks.
 */

const OPEN_STATUSES = ['published', 'clarifications'] as const;
const LIMIT = 10;

type Scope = TenderOpportunitiesDto['scope'];

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

export async function loadTenderOpportunities(
  tx: DbExecutor,
  identity: RequestIdentity,
  marketId: string,
): Promise<TenderOpportunitiesDto> {
  if (identity.featureFlags[TENDERING_FEATURE] !== true) return NO_TENDER_OPPORTUNITIES;
  const scope = tenderScopeFor(identity);
  if (scope === 'none') return { moduleEnabled: true, scope, items: [] };

  const t = schema.tenders;
  const conditions: SQL[] = [
    inArray(t.status, [...OPEN_STATUSES]),
    gt(t.submissionDeadlineAt, sql`now()`),
    or(isNull(t.releaseAt), lte(t.releaseAt, sql`now()`)) as SQL,
    or(
      eq(schema.projects.marketId, marketId),
      eq(schema.properties.marketId, marketId),
      eq(schema.serviceRequests.marketId, marketId),
    ) as SQL,
  ];
  if (scope === 'customer') {
    conditions.push(eq(t.organizationId, identity.ctx.organizationId as string));
  }
  if (scope === 'partner') {
    conditions.push(
      eq(schema.tenderInvitations.partnerUserId, identity.ctx.userId as string),
      sql`${schema.tenderInvitations.status} <> 'declined'`,
    );
  }

  const base = tx
    .select({
      id: t.id,
      reference: t.reference,
      title: t.title,
      status: t.status,
      releaseAt: t.releaseAt,
      submissionDeadlineAt: t.submissionDeadlineAt,
      displayTimeZone: t.displayTimeZone,
      projectMarketId: schema.projects.marketId,
      propertyMarketId: schema.properties.marketId,
      serviceRequestMarketId: schema.serviceRequests.marketId,
    })
    .from(t)
    .leftJoin(schema.projects, eq(schema.projects.id, t.projectId))
    .leftJoin(schema.properties, eq(schema.properties.id, schema.projects.propertyId))
    .leftJoin(schema.serviceRequests, eq(schema.serviceRequests.id, t.serviceRequestId));
  const joined =
    scope === 'partner'
      ? base.innerJoin(schema.tenderInvitations, eq(schema.tenderInvitations.tenderId, t.id))
      : base;
  const rows = await joined
    .where(and(...conditions))
    .orderBy(asc(t.submissionDeadlineAt), asc(t.id))
    .limit(LIMIT);

  return {
    moduleEnabled: true,
    scope,
    items: rows.flatMap((row) => {
      if (
        !row.submissionDeadlineAt ||
        (row.status !== 'published' && row.status !== 'clarifications')
      ) {
        return [];
      }
      const linkedThrough =
        row.projectMarketId === marketId
          ? ('project' as const)
          : row.propertyMarketId === marketId
            ? ('property' as const)
            : ('service_request' as const);
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
    }),
  };
}
