import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import {
  actorId,
  assertVersion,
  authorize,
  changedFields,
  iso,
  notFound,
  transact,
  type AdminContext,
} from '../context';

export interface NeighborhoodDto {
  id: string;
  marketId: string;
  slug: string;
  name: string;
  boundaryGeoJson: string | null;
  centroid: { lon: number; lat: number } | null;
  boundarySourceId: string | null;
  boundaryNote: string | null;
  publicationState: 'draft' | 'in_review' | 'published' | 'unpublished' | 'archived';
  profileMarkdown: string | null;
  version: number;
  archivedAt: string | null;
  updatedAt: string;
}

const selection = {
  id: schema.neighborhoods.id,
  marketId: schema.neighborhoods.marketId,
  slug: schema.neighborhoods.slug,
  name: schema.neighborhoods.name,
  boundaryGeoJson: sql<string | null>`ST_AsGeoJSON(${schema.neighborhoods.boundary})`,
  centroid: schema.neighborhoods.centroid,
  boundarySourceId: schema.neighborhoods.boundarySourceId,
  boundaryNote: schema.neighborhoods.boundaryNote,
  publicationState: schema.neighborhoods.publicationState,
  profileMarkdown: schema.neighborhoods.profileMarkdown,
  version: schema.neighborhoods.version,
  archivedAt: schema.neighborhoods.archivedAt,
  updatedAt: schema.neighborhoods.updatedAt,
};

function toDto(r: {
  id: string;
  marketId: string;
  slug: string;
  name: string;
  boundaryGeoJson: string | null;
  centroid: { lon: number; lat: number } | null;
  boundarySourceId: string | null;
  boundaryNote: string | null;
  publicationState: NeighborhoodDto['publicationState'];
  profileMarkdown: string | null;
  version: number;
  archivedAt: Date | null;
  updatedAt: Date;
}): NeighborhoodDto {
  return { ...r, archivedAt: iso(r.archivedAt), updatedAt: r.updatedAt.toISOString() };
}

/**
 * Validates a GeoJSON boundary with PostGIS (ST_IsValid) and returns it
 * normalised to a MultiPolygon. Runs in its own transaction because a failed
 * statement would poison the caller's transaction.
 */
export async function validateBoundary(ctx: AdminContext, geojson: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(geojson);
  } catch {
    throw new ApiError('validation_failed', 'boundary must be a GeoJSON geometry', {
      details: [{ path: 'boundaryGeoJson', message: 'invalid JSON' }],
    });
  }
  const type = (parsed as { type?: unknown } | null)?.type;
  if (type !== 'MultiPolygon' && type !== 'Polygon') {
    throw new ApiError('validation_failed', 'boundary must be a Polygon or MultiPolygon', {
      details: [{ path: 'boundaryGeoJson', message: `unsupported geometry type ${String(type)}` }],
    });
  }
  let row: { valid: boolean; reason: string | null; normalised: string } | undefined;
  try {
    const res = await transact(ctx, (tx) =>
      tx.execute<{ valid: boolean; reason: string | null; normalised: string }>(sql`
        select ST_IsValid(g) as valid, ST_IsValidReason(g) as reason, ST_AsGeoJSON(ST_Multi(g)) as normalised
        from (select ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(parsed)}), 4326) as g) s
      `),
    );
    row = res.rows[0];
  } catch (err) {
    const message =
      err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : '';
    throw new ApiError('validation_failed', `boundary could not be parsed: ${message}`, {
      details: [{ path: 'boundaryGeoJson', message }],
    });
  }
  if (!row || !row.valid) {
    throw new ApiError(
      'validation_failed',
      `boundary is not a valid geometry: ${row?.reason ?? ''}`,
      {
        details: [{ path: 'boundaryGeoJson', message: row?.reason ?? 'ST_IsValid returned false' }],
      },
    );
  }
  return row.normalised;
}

async function loadMarketState(tx: Transaction, marketId: string) {
  const rows = await tx
    .select({ id: schema.markets.id, publicationState: schema.markets.publicationState })
    .from(schema.markets)
    .where(eq(schema.markets.id, marketId));
  if (!rows[0]) throw notFound('market');
  return rows[0];
}

export async function listNeighborhoods(
  ctx: AdminContext,
  marketId: string,
): Promise<NeighborhoodDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select(selection)
      .from(schema.neighborhoods)
      .where(eq(schema.neighborhoods.marketId, marketId))
      .orderBy(asc(schema.neighborhoods.name));
    return rows.map(toDto);
  });
}

export async function createNeighborhood(
  ctx: AdminContext,
  marketId: string,
  input: {
    slug: string;
    name: string;
    boundaryGeoJson?: string | null;
    boundarySourceId?: string | null;
    boundaryNote?: string | null;
    profileMarkdown?: string | null;
    changeReason?: string;
  },
): Promise<NeighborhoodDto> {
  authorize(ctx, 'market_data.edit');
  const userId = actorId(ctx);
  const boundary = input.boundaryGeoJson
    ? await validateBoundary(ctx, input.boundaryGeoJson)
    : null;
  return transact(ctx, async (tx) => {
    await loadMarketState(tx, marketId);
    const dup = await tx
      .select({ id: schema.neighborhoods.id })
      .from(schema.neighborhoods)
      .where(
        and(eq(schema.neighborhoods.marketId, marketId), eq(schema.neighborhoods.slug, input.slug)),
      );
    if (dup.length > 0)
      throw new ApiError(
        'conflict',
        `neighborhood slug "${input.slug}" already exists in this market`,
      );
    const [row] = await tx
      .insert(schema.neighborhoods)
      .values({
        marketId,
        slug: input.slug,
        name: input.name,
        boundary,
        boundarySourceId: input.boundarySourceId ?? null,
        boundaryNote: input.boundaryNote ?? null,
        profileMarkdown: input.profileMarkdown ?? null,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: schema.neighborhoods.id });
    if (boundary) {
      await tx.execute(
        sql`update neighborhoods set centroid = ST_Centroid(boundary) where id = ${row!.id}`,
      );
    }
    const [created] = await tx
      .select(selection)
      .from(schema.neighborhoods)
      .where(eq(schema.neighborhoods.id, row!.id));
    await recordAudit(tx, ctx.identity, {
      action: 'neighborhood.created',
      entityType: 'neighborhood',
      entityId: row!.id,
      after: { marketId, slug: input.slug, name: input.name, hasBoundary: Boolean(boundary) },
      reason: input.changeReason ?? null,
      correlationId: ctx.correlationId,
    });
    return toDto(created!);
  });
}

export async function patchNeighborhood(
  ctx: AdminContext,
  marketId: string,
  neighborhoodId: string,
  input: {
    slug?: string;
    name?: string;
    boundaryGeoJson?: string | null;
    boundarySourceId?: string | null;
    boundaryNote?: string | null;
    profileMarkdown?: string | null;
    publicationState?: NeighborhoodDto['publicationState'];
    expectedVersion: number;
    changeReason: string;
  },
): Promise<NeighborhoodDto> {
  const userId = actorId(ctx);
  const boundary =
    input.boundaryGeoJson === undefined
      ? undefined
      : input.boundaryGeoJson
        ? await validateBoundary(ctx, input.boundaryGeoJson)
        : null;
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select(selection)
      .from(schema.neighborhoods)
      .where(
        and(
          eq(schema.neighborhoods.id, neighborhoodId),
          eq(schema.neighborhoods.marketId, marketId),
        ),
      );
    const current = rows[0];
    if (!current) throw notFound('neighborhood');
    const publishing =
      current.publicationState === 'published' || input.publicationState === 'published';
    authorize(ctx, publishing ? 'market_data.publish' : 'market_data.edit', {
      type: 'neighborhood',
      id: neighborhoodId,
    });
    assertVersion(current.version, input.expectedVersion);
    if (input.slug && input.slug !== current.slug) {
      const dup = await tx
        .select({ id: schema.neighborhoods.id })
        .from(schema.neighborhoods)
        .where(
          and(
            eq(schema.neighborhoods.marketId, marketId),
            eq(schema.neighborhoods.slug, input.slug),
          ),
        );
      if (dup.length > 0)
        throw new ApiError('conflict', `neighborhood slug "${input.slug}" already exists`);
    }
    await tx
      .update(schema.neighborhoods)
      .set({
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(boundary !== undefined ? { boundary } : {}),
        ...(input.boundarySourceId !== undefined
          ? { boundarySourceId: input.boundarySourceId }
          : {}),
        ...(input.boundaryNote !== undefined ? { boundaryNote: input.boundaryNote } : {}),
        ...(input.profileMarkdown !== undefined ? { profileMarkdown: input.profileMarkdown } : {}),
        ...(input.publicationState !== undefined
          ? {
              publicationState: input.publicationState,
              archivedAt: input.publicationState === 'archived' ? new Date() : null,
            }
          : {}),
        version: current.version + 1,
        updatedBy: userId,
      })
      .where(
        and(
          eq(schema.neighborhoods.id, neighborhoodId),
          eq(schema.neighborhoods.version, current.version),
        ),
      );
    if (boundary !== undefined) {
      await tx.execute(
        boundary
          ? sql`update neighborhoods set centroid = ST_Centroid(boundary) where id = ${neighborhoodId}`
          : sql`update neighborhoods set centroid = null where id = ${neighborhoodId}`,
      );
    }
    const [updated] = await tx
      .select(selection)
      .from(schema.neighborhoods)
      .where(eq(schema.neighborhoods.id, neighborhoodId));
    const before = toDto(current) as unknown as Record<string, unknown>;
    const after = toDto(updated!) as unknown as Record<string, unknown>;
    const diff = changedFields(
      { ...before, boundaryGeoJson: before['boundaryGeoJson'] ? '[geometry]' : null },
      { ...after, boundaryGeoJson: after['boundaryGeoJson'] ? '[geometry]' : null },
    );
    await recordAudit(tx, ctx.identity, {
      action: 'neighborhood.updated',
      entityType: 'neighborhood',
      entityId: neighborhoodId,
      before: diff.before,
      after: diff.after,
      reason: input.changeReason,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!);
  });
}
