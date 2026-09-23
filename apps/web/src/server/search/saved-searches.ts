import 'server-only';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import {
  ApiError,
  searchCriteriaSchema,
  type SavedSearchCreate,
  type SavedSearchDto,
  type SavedSearchMatchesDto,
  type SavedSearchUpdate,
  type SearchListingDto,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeOrg } from '@simplexd/domain/authz';
import { isUnconstrained, matchListing, type SearchCriteria } from '@simplexd/domain/search';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  assertUpdatedAt,
  ctxFor,
  notFound,
  userIdOf,
  type ServiceOptions,
} from '@/server/projects/shared';
import { loadPublishedListings, toSearchListingDto } from './listings';

/**
 * Saved searches belong to one user (row-level security: owner only, staff
 * privileged for support). They live in the organisation that was active
 * when they were created, so switching organisation hides them. Alerts are
 * delivered by the scheduled job in @simplexd/notifications
 * (`runSavedSearchAlerts`): enabling alerts sets the watermark to now, so
 * only listings published from then on are announced.
 */

type Row = typeof schema.savedSearches.$inferSelect;

function criteriaOf(raw: unknown): SearchCriteria {
  const parsed = searchCriteriaSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export function toSavedSearchDto(row: Row): SavedSearchDto {
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    criteria: searchCriteriaSchema.parse(criteriaOf(row.criteria)),
    alertsEnabled: row.alertsEnabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function orgScope(identity: RequestIdentity) {
  const orgId = identity.ctx.organizationId;
  return orgId
    ? eq(schema.savedSearches.organizationId, orgId)
    : isNull(schema.savedSearches.organizationId);
}

/** Loads a saved search the caller owns (support staff read through RLS but never act). */
async function loadOwn(tx: Transaction, identity: RequestIdentity, id: string): Promise<Row> {
  const userId = userIdOf(identity);
  const [row] = await tx
    .select()
    .from(schema.savedSearches)
    .where(and(eq(schema.savedSearches.id, id), eq(schema.savedSearches.userId, userId)));
  if (!row) throw notFound('saved search');
  return row;
}

function assertCanManage(identity: RequestIdentity): void {
  userIdOf(identity);
  const orgId = identity.ctx.organizationId;
  if (orgId) {
    assertAllowed(
      authorizeOrg(identity.actor, 'org.scenarios.manage', {
        type: 'saved_search',
        organizationId: orgId,
      }),
    );
  }
}

export async function listSavedSearches(identity: RequestIdentity): Promise<SavedSearchDto[]> {
  const userId = userIdOf(identity);
  const rows = await withActor(getDb(), ctxFor(identity), (tx) =>
    tx
      .select()
      .from(schema.savedSearches)
      .where(
        and(
          eq(schema.savedSearches.userId, userId),
          or(orgScope(identity), isNull(schema.savedSearches.organizationId)),
        ),
      )
      .orderBy(desc(schema.savedSearches.createdAt)),
  );
  return rows.map(toSavedSearchDto);
}

export async function getSavedSearch(
  identity: RequestIdentity,
  id: string,
): Promise<SavedSearchDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) =>
    toSavedSearchDto(await loadOwn(tx, identity, id)),
  );
}

export async function createSavedSearch(
  identity: RequestIdentity,
  input: SavedSearchCreate,
  options: ServiceOptions = {},
): Promise<SavedSearchDto> {
  assertCanManage(identity);
  const userId = userIdOf(identity);
  if (isUnconstrained(input.criteria)) {
    throw new ApiError('validation_failed', 'choose at least one criterion for the search', {
      details: [{ path: 'criteria', message: 'the criteria would match every listing' }],
    });
  }
  const now = new Date();
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [row] = await tx
      .insert(schema.savedSearches)
      .values({
        userId,
        organizationId: identity.ctx.organizationId ?? null,
        name: input.name,
        criteria: input.criteria,
        alertsEnabled: input.alertsEnabled,
        lastRunAt: input.alertsEnabled ? now : null,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'saved_search.created',
      entityType: 'saved_search',
      entityId: row!.id,
      after: { name: row!.name, alertsEnabled: row!.alertsEnabled, criteria: row!.criteria },
      correlationId: options.correlationId,
    });
    return toSavedSearchDto(row!);
  });
}

export async function updateSavedSearch(
  identity: RequestIdentity,
  id: string,
  input: SavedSearchUpdate,
  options: ServiceOptions = {},
): Promise<SavedSearchDto> {
  assertCanManage(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const row = await loadOwn(tx, identity, id);
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const criteria = input.criteria ?? criteriaOf(row.criteria);
    if (input.criteria && isUnconstrained(input.criteria)) {
      throw new ApiError('validation_failed', 'choose at least one criterion for the search', {
        details: [{ path: 'criteria', message: 'the criteria would match every listing' }],
      });
    }
    const alertsEnabled = input.alertsEnabled ?? row.alertsEnabled;
    const now = new Date();
    const [updated] = await tx
      .update(schema.savedSearches)
      .set({
        name: input.name ?? row.name,
        criteria,
        alertsEnabled,
        // Turning alerts on starts from now; changing criteria also restarts
        // the watermark so earlier listings are not announced retroactively.
        lastRunAt:
          alertsEnabled && (!row.alertsEnabled || input.criteria) ? now : row.lastRunAt,
        updatedAt: now,
      })
      .where(eq(schema.savedSearches.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'saved_search.updated',
      entityType: 'saved_search',
      entityId: id,
      before: { name: row.name, alertsEnabled: row.alertsEnabled, criteria: row.criteria },
      after: { name: updated!.name, alertsEnabled: updated!.alertsEnabled, criteria },
      correlationId: options.correlationId,
    });
    return toSavedSearchDto(updated!);
  });
}

export async function deleteSavedSearch(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<void> {
  assertCanManage(identity);
  await withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const row = await loadOwn(tx, identity, id);
    await tx.delete(schema.savedSearches).where(eq(schema.savedSearches.id, row.id));
    await recordAudit(tx, identity, {
      action: 'saved_search.deleted',
      entityType: 'saved_search',
      entityId: id,
      before: { name: row.name },
      correlationId: options.correlationId,
    });
  });
}

/** Listings currently published that match the saved search (a preview, not the alert ledger). */
export async function getSavedSearchMatches(
  identity: RequestIdentity,
  id: string,
  limit = 50,
): Promise<SavedSearchMatchesDto> {
  const row = await withActor(getDb(), ctxFor(identity), (tx) => loadOwn(tx, identity, id));
  const criteria = criteriaOf(row.criteria);
  const listings = await loadPublishedListings({});
  const now = new Date();
  const items: SearchListingDto[] = [];
  for (const l of listings) {
    if (row.organizationId && l.organizationId === row.organizationId) continue;
    if (matchListing(criteria, l, now).matches) items.push(toSearchListingDto(l));
    if (items.length >= limit) break;
  }
  return { items, evaluated: listings.length };
}

/** Published listings for the staff shortlist picker (title search). */
export async function searchPublishedListings(
  identity: RequestIdentity,
  query: { q?: string; limit: number },
): Promise<SearchListingDto[]> {
  userIdOf(identity);
  const listings = await loadPublishedListings({});
  const needle = query.q?.trim().toLowerCase();
  return listings
    .filter((l) => !needle || l.title.toLowerCase().includes(needle))
    .slice(0, query.limit)
    .map(toSearchListingDto);
}
