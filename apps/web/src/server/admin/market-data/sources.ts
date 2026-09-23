import 'server-only';
import { asc, eq, ilike, or, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import {
  actorId,
  assertUpdatedAt,
  authorize,
  changedFields,
  notFound,
  transact,
  type AdminContext,
} from '../context';

type SourceRow = typeof schema.sources.$inferSelect;

export interface SourceDto {
  id: string;
  slug: string;
  title: string;
  publisher: string | null;
  url: string | null;
  dataUrl: string | null;
  licenseNote: string | null;
  licenseRights: SourceRow['licenseRights'];
  useNote: string | null;
  retrievedAt: string | null;
  observationCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(r: SourceRow & { observationCount?: number }): SourceDto {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    publisher: r.publisher,
    url: r.url,
    dataUrl: r.dataUrl,
    licenseNote: r.licenseNote,
    licenseRights: r.licenseRights,
    useNote: r.useNote,
    retrievedAt: r.retrievedAt,
    observationCount: r.observationCount ?? 0,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listSources(
  ctx: AdminContext,
  query: { q?: string; limit: number } = { limit: 200 },
): Promise<SourceDto[]> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const pattern = query.q ? `%${query.q.replace(/[%_]/g, '')}%` : null;
    const rows = await tx
      .select({
        source: schema.sources,
        observationCount: sql<number>`(select count(*)::int from observations o where o.source_id = ${schema.sources.id})`,
      })
      .from(schema.sources)
      .where(
        pattern
          ? or(
              ilike(schema.sources.title, pattern),
              ilike(schema.sources.slug, pattern),
              ilike(schema.sources.publisher, pattern),
            )
          : undefined,
      )
      .orderBy(asc(schema.sources.title))
      .limit(query.limit);
    return rows.map((r) => toDto({ ...r.source, observationCount: r.observationCount }));
  });
}

export async function getSource(ctx: AdminContext, id: string): Promise<SourceDto> {
  authorize(ctx, 'market_data.read_drafts');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.sources).where(eq(schema.sources.id, id));
    if (!rows[0]) throw notFound('source');
    return toDto(rows[0]);
  });
}

export interface SourceInput {
  slug?: string;
  title?: string;
  publisher?: string | null;
  url?: string | null;
  dataUrl?: string | null;
  licenseNote?: string | null;
  licenseRights?: SourceRow['licenseRights'];
  useNote?: string | null;
  retrievedAt?: string | null;
}

export async function createSource(
  ctx: AdminContext,
  input: SourceInput & { slug: string; title: string; licenseRights: SourceRow['licenseRights'] },
): Promise<SourceDto> {
  authorize(ctx, 'market_data.edit');
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    const dup = await tx
      .select({ id: schema.sources.id })
      .from(schema.sources)
      .where(eq(schema.sources.slug, input.slug));
    if (dup.length > 0)
      throw new ApiError('conflict', `a source with slug "${input.slug}" already exists`);
    const [row] = await tx
      .insert(schema.sources)
      .values({
        slug: input.slug,
        title: input.title,
        publisher: input.publisher ?? null,
        url: input.url ?? null,
        dataUrl: input.dataUrl ?? null,
        licenseNote: input.licenseNote ?? null,
        licenseRights: input.licenseRights,
        useNote: input.useNote ?? null,
        retrievedAt: input.retrievedAt ?? null,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'source.created',
      entityType: 'source',
      entityId: row!.id,
      after: toDto(row!),
      correlationId: ctx.correlationId,
    });
    return toDto(row!);
  });
}

export async function patchSource(
  ctx: AdminContext,
  id: string,
  input: SourceInput & { reason: string; expectedUpdatedAt?: string },
): Promise<SourceDto> {
  authorize(ctx, 'market_data.edit');
  return transact(ctx, async (tx) => {
    const rows = await tx.select().from(schema.sources).where(eq(schema.sources.id, id));
    const current = rows[0];
    if (!current) throw notFound('source');
    assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    const [updated] = await tx
      .update(schema.sources)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.publisher !== undefined ? { publisher: input.publisher } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.dataUrl !== undefined ? { dataUrl: input.dataUrl } : {}),
        ...(input.licenseNote !== undefined ? { licenseNote: input.licenseNote } : {}),
        ...(input.licenseRights !== undefined ? { licenseRights: input.licenseRights } : {}),
        ...(input.useNote !== undefined ? { useNote: input.useNote } : {}),
        ...(input.retrievedAt !== undefined ? { retrievedAt: input.retrievedAt } : {}),
      })
      .where(eq(schema.sources.id, id))
      .returning();
    const diff = changedFields(
      toDto(current) as unknown as Record<string, unknown>,
      toDto(updated!) as unknown as Record<string, unknown>,
    );
    await recordAudit(tx, ctx.identity, {
      action: 'source.updated',
      entityType: 'source',
      entityId: id,
      before: diff.before,
      after: diff.after,
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!);
  });
}
