import 'server-only';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SupplierDirectoryEntry, SupplierDirectoryQuery } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { assertAllowed, authorizeStaff } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { quoteBadge, quoteFreshness, supplierLeadBadge } from '@/server/markets/evidence';
import { toQuoteDto } from '@/server/markets/mappers';
import { loadFreshnessPolicies } from '@/server/markets/policy';
import { ctxFor, requireProcurement, type ServiceOptions } from './shared';

/**
 * Supplier directory for staff: the supply facilities and market coverage
 * carried by the research seed, with the evidence labels they were imported
 * with. Prices appear only when a supplier quote is actually on file; nothing
 * is estimated.
 */

const EVIDENCE_LABELS: Record<SupplierDirectoryEntry['evidenceStatus'], string> = {
  published_facility_location: 'Published facility location; delivery and pricing not verified',
  unverified_lead: 'Unverified lead',
  verified_supplier: 'Verified supplier',
};

const RELATION_LABELS: Record<string, string> = {
  editorial_lead: 'Research lead, not a verified delivery route',
  verified_delivery: 'Delivery to this market verified',
  dealer_appointed: 'Appointed dealer for this market',
};

export const SUPPLIER_DIRECTORY_NOTE =
  'Facilities and coverage come from the research seed and later staff edits. A listed facility is not a delivery route and carries no price unless a reviewed supplier quote is on file.';

export async function listSupplierDirectory(
  identity: RequestIdentity,
  query: SupplierDirectoryQuery,
  options: ServiceOptions = {},
): Promise<{ items: SupplierDirectoryEntry[]; note: string }> {
  requireProcurement(identity);
  assertAllowed(authorizeStaff(identity.actor, 'procurement.manage'));
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const asOf = new Date();
    const policies = await loadFreshnessPolicies(tx);
    const facilities = await tx
      .select({ facility: schema.supplyFacilities, stateName: schema.states.name })
      .from(schema.supplyFacilities)
      .leftJoin(schema.states, eq(schema.states.id, schema.supplyFacilities.stateId))
      .where(
        and(
          query.material ? eq(schema.supplyFacilities.material, query.material) : undefined,
          query.stateId ? eq(schema.supplyFacilities.stateId, query.stateId) : undefined,
          query.includeArchived === 'true' ? undefined : isNull(schema.supplyFacilities.archivedAt),
        ),
      )
      .orderBy(asc(schema.supplyFacilities.material), asc(schema.supplyFacilities.name));
    const facilityIds = facilities.map((f) => f.facility.id);
    if (facilityIds.length === 0) return { items: [], note: SUPPLIER_DIRECTORY_NOTE };
    const coverage = await tx
      .select({ coverage: schema.supplierCoverage, marketName: schema.markets.name })
      .from(schema.supplierCoverage)
      .leftJoin(schema.markets, eq(schema.markets.id, schema.supplierCoverage.marketId))
      .where(
        and(
          inArray(schema.supplierCoverage.facilityId, facilityIds),
          query.marketId ? eq(schema.supplierCoverage.marketId, query.marketId) : undefined,
        ),
      );
    const quotes = await tx
      .select()
      .from(schema.supplierQuotes)
      .where(
        and(
          inArray(schema.supplierQuotes.facilityId, facilityIds),
          query.marketId ? eq(schema.supplierQuotes.marketId, query.marketId) : undefined,
          sql`${schema.supplierQuotes.reviewStatus} <> 'rejected'`,
        ),
      )
      .orderBy(asc(schema.supplierQuotes.quotedAt));
    const items: SupplierDirectoryEntry[] = [];
    for (const { facility, stateName } of facilities) {
      const cov = coverage.filter((c) => c.coverage.facilityId === facility.id);
      if (query.marketId && cov.length === 0) continue;
      const own = quotes.filter((q) => q.facilityId === facility.id);
      let priceEvidence: SupplierDirectoryEntry['priceEvidence'] = 'no_quote_on_file';
      const quoteDtos = own.map((q) => {
        const freshness = quoteFreshness(q, policies, asOf);
        const badge = quoteBadge(q, freshness);
        if (badge === 'disputed') priceEvidence = 'disputed_quote';
        else if (freshness === 'stale' && priceEvidence === 'no_quote_on_file')
          priceEvidence = 'stale_quote';
        else if (q.reviewStatus === 'verified' && freshness === 'fresh')
          priceEvidence = 'verified_quote';
        else if (priceEvidence === 'no_quote_on_file') priceEvidence = 'quote_pending_review';
        return toQuoteDto(q, { asOf, policies });
      });
      items.push({
        facilityId: facility.id,
        slug: facility.slug,
        name: facility.name,
        operator: facility.operator,
        material: facility.material,
        stateId: facility.stateId,
        stateName: stateName ?? null,
        evidenceStatus: facility.evidenceStatus,
        evidenceLabel: EVIDENCE_LABELS[facility.evidenceStatus],
        deliveryCoverageVerified: facility.deliveryCoverageVerified,
        stockStatus: facility.stockStatus,
        rankEligible: facility.rankEligible,
        contactPermission: facility.contactPermission,
        notes: facility.notes,
        location: facility.location ?? null,
        archivedAt: facility.archivedAt ? facility.archivedAt.toISOString() : null,
        coverage: cov.map((c) => ({
          marketId: c.coverage.marketId,
          marketName: c.marketName ?? null,
          relation: c.coverage.relation,
          relationLabel: RELATION_LABELS[c.coverage.relation] ?? c.coverage.relation,
          verifiedAt: c.coverage.verifiedAt ? c.coverage.verifiedAt.toISOString() : null,
          note: c.coverage.note,
          badge: supplierLeadBadge({ coverage: c.coverage, facility, state: null, source: null }),
        })),
        quotes: quoteDtos,
        priceEvidence,
      });
    }
    return { items, note: SUPPLIER_DIRECTORY_NOTE };
  });
}
