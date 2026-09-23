import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { appendOutbox, schema } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import { actorId, authorize, iso, notFound, transact, type AdminContext } from '../context';

export interface CoverageRowDto {
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  category: 'core' | 'expansion';
  servicePublicationState: string;
  availability: (typeof schema.serviceAvailabilityEnum.enumValues)[number] | null;
  note: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  updatedAt: string | null;
}

/** Per-service availability for a market; services without a row are shown as unset. */
export async function listCoverage(ctx: AdminContext, marketId: string): Promise<CoverageRowDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const services = await tx
      .select({
        id: schema.services.id,
        slug: schema.services.slug,
        name: schema.services.name,
        category: schema.services.category,
        publicationState: schema.services.publicationState,
      })
      .from(schema.services)
      .orderBy(asc(schema.services.sortOrder));
    const coverage = await tx
      .select()
      .from(schema.serviceCoverage)
      .where(eq(schema.serviceCoverage.marketId, marketId));
    const byService = new Map(coverage.map((c) => [c.serviceId, c]));
    return services.map((s) => {
      const c = byService.get(s.id);
      return {
        serviceId: s.id,
        serviceSlug: s.slug,
        serviceName: s.name,
        category: s.category,
        servicePublicationState: s.publicationState,
        availability: c?.availability ?? null,
        note: c?.note ?? null,
        effectiveFrom: c?.effectiveFrom ?? null,
        effectiveTo: c?.effectiveTo ?? null,
        updatedAt: iso(c?.updatedAt ?? null),
      };
    });
  });
}

export async function updateCoverage(
  ctx: AdminContext,
  marketId: string,
  input: {
    items: Array<{
      serviceId: string;
      availability: (typeof schema.serviceAvailabilityEnum.enumValues)[number];
      note?: string | null;
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
    }>;
    reason: string;
  },
): Promise<CoverageRowDto[]> {
  authorize(ctx, 'market_data.edit');
  const userId = actorId(ctx);
  const published = await transact(ctx, async (tx) => {
    const market = await tx
      .select({ id: schema.markets.id, publicationState: schema.markets.publicationState })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    if (!market[0]) throw notFound('market');
    const before = await tx
      .select({
        serviceId: schema.serviceCoverage.serviceId,
        availability: schema.serviceCoverage.availability,
        note: schema.serviceCoverage.note,
      })
      .from(schema.serviceCoverage)
      .where(eq(schema.serviceCoverage.marketId, marketId));
    for (const item of input.items) {
      await tx
        .insert(schema.serviceCoverage)
        .values({
          marketId,
          serviceId: item.serviceId,
          availability: item.availability,
          note: item.note ?? null,
          effectiveFrom: item.effectiveFrom ?? null,
          effectiveTo: item.effectiveTo ?? null,
          updatedBy: userId,
        })
        .onConflictDoUpdate({
          target: [schema.serviceCoverage.marketId, schema.serviceCoverage.serviceId],
          set: {
            availability: item.availability,
            note: item.note ?? null,
            effectiveFrom: item.effectiveFrom ?? null,
            effectiveTo: item.effectiveTo ?? null,
            updatedBy: userId,
            updatedAt: new Date(),
          },
        });
    }
    await recordAudit(tx, ctx.identity, {
      action: 'service_coverage.updated',
      entityType: 'market',
      entityId: marketId,
      before: { coverage: before },
      after: { coverage: input.items },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    const isPublished = market[0].publicationState === 'published';
    if (isPublished) {
      await appendOutbox(tx, {
        eventType: 'market_data.published',
        aggregateType: 'market',
        aggregateId: marketId,
        actorUserId: userId,
        payload: { marketId, reason: `service coverage: ${input.reason}` },
        correlationId: ctx.correlationId,
      });
    }
    return isPublished;
  });
  if (published) await cacheDelete('markets');
  return listCoverage(ctx, marketId);
}
