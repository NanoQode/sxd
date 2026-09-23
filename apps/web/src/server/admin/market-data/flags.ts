import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { appendOutbox, schema, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import {
  actorId,
  assertUpdatedAt,
  authorize,
  changedFields,
  notFound,
  transact,
  type AdminContext,
} from '../context';

type FlagRow = typeof schema.marketFlags.$inferSelect;

export interface MarketFlagDto {
  id: string;
  marketId: string | null;
  neighborhoodId: string | null;
  flagType: FlagRow['flagType'];
  active: boolean;
  note: string;
  sourceId: string | null;
  validFrom: string | null;
  validUntil: string | null;
  approvedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(r: FlagRow): MarketFlagDto {
  return {
    id: r.id,
    marketId: r.marketId,
    neighborhoodId: r.neighborhoodId,
    flagType: r.flagType,
    active: r.active,
    note: r.note,
    sourceId: r.sourceId,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
    approvedBy: r.approvedBy,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listFlags(ctx: AdminContext, marketId: string): Promise<MarketFlagDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.marketFlags)
      .where(eq(schema.marketFlags.marketId, marketId))
      .orderBy(desc(schema.marketFlags.active), desc(schema.marketFlags.createdAt));
    return rows.map(toDto);
  });
}

/** Flags that block or exclude a market from ranking need the approver; advisories need edit. */
function permissionFor(flagType: FlagRow['flagType']) {
  return flagType === 'geographic_exclusion' ||
    flagType === 'title_stop' ||
    flagType === 'site_restriction'
    ? ('market_data.publish' as const)
    : ('market_data.edit' as const);
}

async function notifyIfPublished(
  ctx: AdminContext,
  tx: Transaction,
  marketId: string,
  reason: string,
): Promise<boolean> {
  const market = await tx
    .select({ publicationState: schema.markets.publicationState })
    .from(schema.markets)
    .where(eq(schema.markets.id, marketId));
  if (!market[0]) throw notFound('market');
  if (market[0].publicationState !== 'published') return false;
  await appendOutbox(tx, {
    eventType: 'market_data.published',
    aggregateType: 'market',
    aggregateId: marketId,
    actorUserId: actorId(ctx),
    payload: { marketId, reason },
    correlationId: ctx.correlationId,
  });
  return true;
}

export async function createFlag(
  ctx: AdminContext,
  marketId: string,
  input: {
    flagType: FlagRow['flagType'];
    note: string;
    neighborhoodId?: string | null;
    sourceId?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    active: boolean;
  },
): Promise<MarketFlagDto> {
  authorize(ctx, permissionFor(input.flagType), { type: 'market', id: marketId });
  const userId = actorId(ctx);
  const { row, published } = await transact(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.marketFlags)
      .values({
        marketId,
        neighborhoodId: input.neighborhoodId ?? null,
        flagType: input.flagType,
        active: input.active,
        note: input.note,
        sourceId: input.sourceId ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        approvedBy: permissionFor(input.flagType) === 'market_data.publish' ? userId : null,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'market_flag.created',
      entityType: 'market_flag',
      entityId: row!.id,
      after: toDto(row!),
      reason: input.note,
      correlationId: ctx.correlationId,
    });
    const published = await notifyIfPublished(ctx, tx, marketId, `flag ${input.flagType} created`);
    return { row: row!, published };
  });
  if (published) await cacheDelete('markets');
  return toDto(row);
}

export async function patchFlag(
  ctx: AdminContext,
  marketId: string,
  flagId: string,
  input: {
    note?: string;
    active?: boolean;
    validFrom?: string | null;
    validUntil?: string | null;
    sourceId?: string | null;
    reason: string;
    expectedUpdatedAt?: string;
  },
): Promise<MarketFlagDto> {
  const userId = actorId(ctx);
  const { row, published } = await transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.marketFlags)
      .where(and(eq(schema.marketFlags.id, flagId), eq(schema.marketFlags.marketId, marketId)));
    const current = rows[0];
    if (!current) throw notFound('flag');
    authorize(ctx, permissionFor(current.flagType), { type: 'market', id: marketId });
    assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    const [updated] = await tx
      .update(schema.marketFlags)
      .set({
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(permissionFor(current.flagType) === 'market_data.publish'
          ? { approvedBy: userId }
          : {}),
      })
      .where(eq(schema.marketFlags.id, flagId))
      .returning();
    const diff = changedFields(
      toDto(current) as unknown as Record<string, unknown>,
      toDto(updated!) as unknown as Record<string, unknown>,
    );
    await recordAudit(tx, ctx.identity, {
      action: 'market_flag.updated',
      entityType: 'market_flag',
      entityId: flagId,
      before: diff.before,
      after: diff.after,
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    const published = await notifyIfPublished(
      ctx,
      tx,
      marketId,
      `flag ${current.flagType} updated`,
    );
    return { row: updated!, published };
  });
  if (published) await cacheDelete('markets');
  return toDto(row);
}
