import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  type RedirectDto,
  redirectPatchSchema,
  redirectUpsertSchema,
} from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { cacheDelete, cached } from '@/lib/cache';

type RedirectRow = typeof schema.redirects.$inferSelect;

function toDto(r: RedirectRow): RedirectDto {
  return {
    id: r.id,
    fromPath: r.fromPath,
    toPath: r.toPath,
    statusCode: r.statusCode,
    active: r.active,
    note: r.note,
    hitCount: r.hitCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1);
  return trimmed;
}

export async function listRedirects(identity: RequestIdentity): Promise<RedirectDto[]> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx.select().from(schema.redirects).orderBy(desc(schema.redirects.updatedAt)).limit(500),
  );
  return rows.map(toDto);
}

export async function createRedirect(
  identity: RequestIdentity,
  input: z.infer<typeof redirectUpsertSchema>,
  options: { correlationId: string },
): Promise<RedirectDto> {
  const parsed = redirectUpsertSchema.parse(input);
  const fromPath = normalizePath(parsed.fromPath);
  const toPath = parsed.toPath.startsWith('/') ? normalizePath(parsed.toPath) : parsed.toPath;
  if (fromPath === toPath)
    throw new ApiError('validation_failed', 'a redirect cannot point to itself');
  if (fromPath.startsWith('/api/') || fromPath === '/api')
    throw new ApiError('validation_failed', 'API paths cannot be redirected');
  const dto = await withActor(getDb(), identity.ctx, async (tx) => {
    const existing = await tx
      .select({ id: schema.redirects.id })
      .from(schema.redirects)
      .where(eq(schema.redirects.fromPath, fromPath));
    if (existing.length > 0)
      throw new ApiError('conflict', `a redirect from ${fromPath} already exists`);
    // Prevent two-hop loops: A → B while B → A already exists.
    const reverse = await tx
      .select({ id: schema.redirects.id })
      .from(schema.redirects)
      .where(and(eq(schema.redirects.fromPath, toPath), eq(schema.redirects.toPath, fromPath)));
    if (reverse.length > 0)
      throw new ApiError('validation_failed', 'this redirect would create a loop');
    const [row] = await tx
      .insert(schema.redirects)
      .values({
        fromPath,
        toPath,
        statusCode: parsed.statusCode,
        active: parsed.active,
        note: parsed.note ?? null,
        createdBy: identity.session!.user.id,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'redirect.created',
      entityType: 'redirect',
      entityId: row!.id,
      after: { fromPath, toPath, statusCode: parsed.statusCode, active: parsed.active },
      correlationId: options.correlationId,
    });
    return toDto(row!);
  });
  await cacheDelete('redirect');
  return dto;
}

export async function patchRedirect(
  identity: RequestIdentity,
  id: string,
  input: z.infer<typeof redirectPatchSchema>,
  options: { correlationId: string },
): Promise<RedirectDto> {
  const parsed = redirectPatchSchema.parse(input);
  const dto = await withActor(getDb(), identity.ctx, async (tx) => {
    const [before] = await tx.select().from(schema.redirects).where(eq(schema.redirects.id, id));
    if (!before) throw new ApiError('not_found', 'redirect not found');
    const toPath =
      parsed.toPath !== undefined
        ? parsed.toPath.startsWith('/')
          ? normalizePath(parsed.toPath)
          : parsed.toPath
        : before.toPath;
    if (toPath === before.fromPath)
      throw new ApiError('validation_failed', 'a redirect cannot point to itself');
    const [row] = await tx
      .update(schema.redirects)
      .set({
        ...(parsed.active !== undefined ? { active: parsed.active } : {}),
        ...(parsed.toPath !== undefined ? { toPath } : {}),
        ...(parsed.statusCode !== undefined ? { statusCode: parsed.statusCode } : {}),
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      })
      .where(eq(schema.redirects.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'redirect.updated',
      entityType: 'redirect',
      entityId: id,
      before: {
        toPath: before.toPath,
        statusCode: before.statusCode,
        active: before.active,
        note: before.note,
      },
      after: {
        toPath: row!.toPath,
        statusCode: row!.statusCode,
        active: row!.active,
        note: row!.note,
      },
      correlationId: options.correlationId,
    });
    return toDto(row!);
  });
  await cacheDelete('redirect');
  return dto;
}

export interface ResolvedRedirect {
  toPath: string;
  statusCode: number;
}

/**
 * Looks up an active redirect for a request path. Cached for 60 seconds so the
 * proxy can call it on every navigation; creating or toggling a redirect
 * invalidates the cache. Query strings are ignored for matching.
 */
export async function resolveRedirect(path: string): Promise<ResolvedRedirect | null> {
  const key = normalizePath(path.split('?')[0] ?? path);
  if (!key.startsWith('/')) return null;
  return cached<ResolvedRedirect | null>(`redirect:${key}`, 60, async () => {
    const rows = await withActor(
      getDb(),
      { userId: null, organizationId: null, staff: false },
      (tx) =>
        tx
          .select({ toPath: schema.redirects.toPath, statusCode: schema.redirects.statusCode })
          .from(schema.redirects)
          .where(and(eq(schema.redirects.fromPath, key), eq(schema.redirects.active, true))),
    );
    const row = rows[0];
    return row ? { toPath: row.toPath, statusCode: row.statusCode } : null;
  });
}
