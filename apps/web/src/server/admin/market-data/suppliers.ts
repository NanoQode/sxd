import 'server-only';
import { asc, desc, eq } from 'drizzle-orm';
import { schema } from '@simplexd/db';
import { authorize, iso, transact, type AdminContext } from '../context';

export interface SupplierLeadDto {
  coverageId: string;
  facilityId: string;
  slug: string;
  name: string;
  operator: string | null;
  material: string;
  stateName: string | null;
  evidenceStatus: string;
  stockStatus: string;
  deliveryCoverageVerified: boolean;
  rankEligible: boolean;
  relation: string;
  verifiedAt: string | null;
  note: string | null;
  sourceTitle: string | null;
}

export interface SupplierQuoteDto {
  id: string;
  supplierName: string | null;
  facilityName: string | null;
  material: string;
  specification: string;
  unit: string;
  quantity: string | null;
  unitPriceKobo: string | null;
  deliveryCostKobo: string | null;
  leadTimeDays: number | null;
  quotedAt: string;
  validUntil: string | null;
  reviewStatus: string;
  rankEligible: boolean;
  contactPermission: boolean;
}

/** Editorial supplier leads and quotes for a market (read model for the Suppliers tab). */
export async function listSupplierLeads(
  ctx: AdminContext,
  marketId: string,
): Promise<{ leads: SupplierLeadDto[]; quotes: SupplierQuoteDto[] }> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const leads = await tx
      .select({
        coverageId: schema.supplierCoverage.id,
        facilityId: schema.supplyFacilities.id,
        slug: schema.supplyFacilities.slug,
        name: schema.supplyFacilities.name,
        operator: schema.supplyFacilities.operator,
        material: schema.supplyFacilities.material,
        stateName: schema.states.name,
        evidenceStatus: schema.supplyFacilities.evidenceStatus,
        stockStatus: schema.supplyFacilities.stockStatus,
        deliveryCoverageVerified: schema.supplyFacilities.deliveryCoverageVerified,
        rankEligible: schema.supplyFacilities.rankEligible,
        relation: schema.supplierCoverage.relation,
        verifiedAt: schema.supplierCoverage.verifiedAt,
        note: schema.supplierCoverage.note,
        sourceTitle: schema.sources.title,
      })
      .from(schema.supplierCoverage)
      .innerJoin(schema.supplyFacilities, eq(schema.supplyFacilities.id, schema.supplierCoverage.facilityId))
      .leftJoin(schema.states, eq(schema.states.id, schema.supplyFacilities.stateId))
      .leftJoin(schema.sources, eq(schema.sources.id, schema.supplyFacilities.sourceId))
      .where(eq(schema.supplierCoverage.marketId, marketId))
      .orderBy(asc(schema.supplyFacilities.material), asc(schema.supplyFacilities.name));
    const quotes = await tx
      .select({ q: schema.supplierQuotes, facilityName: schema.supplyFacilities.name })
      .from(schema.supplierQuotes)
      .leftJoin(schema.supplyFacilities, eq(schema.supplyFacilities.id, schema.supplierQuotes.facilityId))
      .where(eq(schema.supplierQuotes.marketId, marketId))
      .orderBy(desc(schema.supplierQuotes.quotedAt));
    return {
      leads: leads.map((l) => ({ ...l, verifiedAt: iso(l.verifiedAt) })),
      quotes: quotes.map(({ q, facilityName }) => ({
        id: q.id,
        supplierName: q.supplierName,
        facilityName,
        material: q.material,
        specification: q.specification,
        unit: q.unit,
        quantity: q.quantity,
        unitPriceKobo: q.unitPriceKobo === null ? null : q.unitPriceKobo.toString(),
        deliveryCostKobo: q.deliveryCostKobo === null ? null : q.deliveryCostKobo.toString(),
        leadTimeDays: q.leadTimeDays,
        quotedAt: q.quotedAt,
        validUntil: q.validUntil,
        reviewStatus: q.reviewStatus,
        rankEligible: q.rankEligible,
        contactPermission: q.contactPermission,
      })),
    };
  });
}
