import 'server-only';
import { parse as parseCsv } from 'csv-parse/sync';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  redirectImportRequestSchema,
  redirectPatchSchema,
  redirectUpsertSchema,
  type RedirectDto,
  type RedirectImportResult,
  type RedirectImportRow,
  type RedirectSnapshot,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { cacheDelete, cached } from '@/lib/cache';
import { isReservedPath, toSitePath } from '@/lib/site-routes';
import { livePageKind } from './site-routes';

type RedirectRow = typeof schema.redirects.$inferSelect;

const anonymous = { userId: null, organizationId: null, staff: false } as const;
const system = { userId: null, organizationId: null, staff: false, bypass: true } as const;

/**
 * Validates a from/to pair the way every write path must: normalised paths,
 * no self-redirects, no API/private/internal sources, and no source that is
 * currently a live page (the proxy resolves redirects before the app, so such
 * a redirect would shadow the page). Returns the normalised pair.
 */
export async function validateRedirectPair(
  tx: Transaction,
  input: { fromPath: string; toPath: string },
): Promise<{ fromPath: string; toPath: string }> {
  const fromPath = normalizePath(input.fromPath);
  const toPath = input.toPath.startsWith('/') ? normalizePath(input.toPath) : input.toPath.trim();
  if (fromPath === toPath)
    throw new ApiError('validation_failed', 'a redirect cannot point to itself');
  if (isReservedPath(fromPath))
    throw new ApiError(
      'validation_failed',
      'API, private and internal paths (for example /api, /admin, /portal, /media) cannot be redirected',
    );
  const live = await livePageKind(tx, fromPath);
  if (live) {
    throw new ApiError(
      'validation_failed',
      `${fromPath} is an existing ${live === 'static' ? 'page' : live} on this site; redirects only apply to paths that would otherwise be 404`,
    );
  }
  // Prevent two-hop loops: A → B while B → A already exists.
  const reverse = await tx
    .select({ id: schema.redirects.id })
    .from(schema.redirects)
    .where(and(eq(schema.redirects.fromPath, toPath), eq(schema.redirects.toPath, fromPath)));
  if (reverse.length > 0)
    throw new ApiError('validation_failed', 'this redirect would create a loop');
  return { fromPath, toPath };
}

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
  const dto = await withActor(getDb(), identity.ctx, async (tx) => {
    const { fromPath, toPath } = await validateRedirectPair(tx, parsed);
    const existing = await tx
      .select({ id: schema.redirects.id })
      .from(schema.redirects)
      .where(eq(schema.redirects.fromPath, fromPath));
    if (existing.length > 0)
      throw new ApiError('conflict', `a redirect from ${fromPath} already exists`);
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
 * Looks up an active redirect for a request path. Cached for 60 seconds;
 * creating or toggling a redirect invalidates the cache. Used by the
 * not-found boundary as the fallback when the proxy snapshot is unavailable.
 * Query strings are ignored for matching.
 */
export async function resolveRedirect(path: string): Promise<ResolvedRedirect | null> {
  const key = normalizePath(path.split('?')[0] ?? path);
  if (!key.startsWith('/')) return null;
  return cached<ResolvedRedirect | null>(`redirect:${key}`, 60, async () => {
    const rows = await withActor(getDb(), anonymous, (tx) =>
      tx
        .select({ toPath: schema.redirects.toPath, statusCode: schema.redirects.statusCode })
        .from(schema.redirects)
        .where(and(eq(schema.redirects.fromPath, key), eq(schema.redirects.active, true))),
    );
    const row = rows[0];
    return row ? { toPath: row.toPath, statusCode: row.statusCode } : null;
  });
}

/**
 * Every active redirect, for the proxy's in-memory table. Cached for 30
 * seconds under the `redirect` prefix, so any write invalidates it; the proxy
 * refreshes its copy on the same cadence.
 */
export async function getRedirectSnapshot(): Promise<RedirectSnapshot> {
  return cached<RedirectSnapshot>('redirect-snapshot', 30, async () => {
    const rows = await withActor(getDb(), anonymous, (tx) =>
      tx
        .select({
          fromPath: schema.redirects.fromPath,
          toPath: schema.redirects.toPath,
          statusCode: schema.redirects.statusCode,
          updatedAt: schema.redirects.updatedAt,
        })
        .from(schema.redirects)
        .where(eq(schema.redirects.active, true))
        .orderBy(schema.redirects.fromPath),
    );
    const latest = rows.reduce((max, r) => Math.max(max, r.updatedAt.getTime()), 0);
    return {
      version: `${rows.length}:${latest}`,
      items: rows.map((r) => ({ from: r.fromPath, to: r.toPath, status: r.statusCode })),
    };
  });
}

/** Increments the hit counter of an active redirect (called from the proxy after responding). */
export async function recordRedirectHit(path: string): Promise<boolean> {
  const key = normalizePath(path.split('?')[0] ?? path);
  if (!key.startsWith('/')) return false;
  const updated = await withActor(getDb(), system, (tx) =>
    tx
      .update(schema.redirects)
      .set({ hitCount: sql`${schema.redirects.hitCount} + 1` })
      .where(and(eq(schema.redirects.fromPath, key), eq(schema.redirects.active, true)))
      .returning({ id: schema.redirects.id }),
  );
  return updated.length > 0;
}

/* ---------------------------------------------------------------------- */
/* Bulk CSV import                                                         */
/* ---------------------------------------------------------------------- */

const FROM_COLUMNS = ['path', 'from_path', 'from', 'source_url', 'source', 'old_url', 'old'];
const TO_COLUMNS = ['target', 'to_path', 'to', 'target_url', 'new_url', 'new'];
/**
 * Redirect status columns. The inventory's `status_code` is the crawled HTTP
 * status of the old URL, not the redirect status, so it only counts for plain
 * `path,target,status_code` files (no `decision` column).
 */
const STATUS_COLUMNS = ['status', 'redirect_status', 'code'];
const ALLOWED_STATUS = new Set([301, 302, 308]);
const MAX_IMPORT_ROWS = 2000;

function pick(row: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const v = row[name];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return undefined;
}

interface ParsedImportRow {
  line: number;
  rawFrom: string;
  rawTo: string;
  rawStatus: string | undefined;
  decision: string | undefined;
}

function parseImportCsv(csv: string): ParsedImportRow[] {
  let records: Record<string, string>[];
  try {
    records = parseCsv(csv, {
      bom: true,
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new ApiError(
      'validation_failed',
      `the CSV could not be parsed: ${(err as Error).message}`,
    );
  }
  if (records.length === 0) throw new ApiError('validation_failed', 'the CSV has no data rows');
  if (records.length > MAX_IMPORT_ROWS)
    throw new ApiError('validation_failed', `at most ${MAX_IMPORT_ROWS} rows per import`);
  const first = records[0]!;
  if (!FROM_COLUMNS.some((c) => c in first) || !TO_COLUMNS.some((c) => c in first)) {
    throw new ApiError(
      'validation_failed',
      'the CSV needs a path (or source_url) column and a target (or target_url) column',
    );
  }
  const inventory = 'decision' in first;
  return records.map((row, i) => ({
    line: i + 2,
    rawFrom: pick(row, FROM_COLUMNS) ?? '',
    rawTo: pick(row, TO_COLUMNS) ?? '',
    rawStatus: pick(row, inventory ? STATUS_COLUMNS : [...STATUS_COLUMNS, 'status_code']),
    decision: inventory ? pick(row, ['decision']) : undefined,
  }));
}

/**
 * Validates every row of a `path,target,status` CSV and, unless `dryRun`,
 * creates the valid ones. Rows that fail validation are reported and skipped;
 * nothing is partially written per row. Inventory rows whose `decision` is
 * not `redirect` are skipped, so the site inventory can be imported as is.
 */
export async function importRedirects(
  identity: RequestIdentity,
  input: z.infer<typeof redirectImportRequestSchema>,
  options: { correlationId: string },
): Promise<RedirectImportResult> {
  const parsed = redirectImportRequestSchema.parse(input);
  const rows = parseImportCsv(parsed.csv);
  const userId = identity.session!.user.id;

  const result = await withActor(getDb(), identity.ctx, async (tx) => {
    const out: RedirectImportRow[] = [];
    const seen = new Map<string, number>();
    const creatable: Array<{ fromPath: string; toPath: string; statusCode: number; line: number }> =
      [];
    const existing = new Map<string, { toPath: string; statusCode: number; active: boolean }>();
    const froms = rows.map((r) => toSitePath(r.rawFrom)).filter((p): p is string => Boolean(p));
    if (froms.length > 0) {
      const found = await tx
        .select({
          fromPath: schema.redirects.fromPath,
          toPath: schema.redirects.toPath,
          statusCode: schema.redirects.statusCode,
          active: schema.redirects.active,
        })
        .from(schema.redirects)
        .where(inArray(schema.redirects.fromPath, froms));
      for (const f of found) existing.set(f.fromPath, f);
    }

    for (const row of rows) {
      const report = (
        outcome: RedirectImportRow['outcome'],
        reason: string | null,
        fromPath = row.rawFrom,
        toPath = row.rawTo,
        statusCode = Number(row.rawStatus ?? 301) || 301,
      ) => out.push({ line: row.line, fromPath, toPath, statusCode, outcome, reason });

      if (row.decision !== undefined && row.decision.toLowerCase() !== 'redirect') {
        report('skip', `inventory decision is "${row.decision}", not redirect`);
        continue;
      }
      const fromPath = toSitePath(row.rawFrom);
      if (!fromPath) {
        report('error', 'path must be an app path starting with / or an absolute URL');
        continue;
      }
      const toPath = row.rawTo.startsWith('/')
        ? toSitePath(row.rawTo)
        : /^https:\/\/[^\s]+$/.test(row.rawTo)
          ? row.rawTo
          : null;
      if (!toPath) {
        report('error', 'target must be a relative path or an https URL', fromPath);
        continue;
      }
      const statusCode = row.rawStatus ? Number(row.rawStatus) : 301;
      if (!ALLOWED_STATUS.has(statusCode)) {
        report('error', 'status must be 301, 302 or 308', fromPath, toPath, statusCode);
        continue;
      }
      const duplicate = seen.get(fromPath);
      if (duplicate !== undefined) {
        report('error', `duplicate of line ${duplicate}`, fromPath, toPath, statusCode);
        continue;
      }
      seen.set(fromPath, row.line);
      const current = existing.get(fromPath);
      if (current) {
        const same =
          current.toPath === toPath && current.statusCode === statusCode && current.active;
        report(
          same ? 'unchanged' : 'error',
          same
            ? null
            : `a redirect from ${fromPath} already exists (to ${current.toPath}, ${current.statusCode}${current.active ? '' : ', inactive'}); edit it in the table instead`,
          fromPath,
          toPath,
          statusCode,
        );
        continue;
      }
      try {
        await validateRedirectPair(tx, { fromPath, toPath });
      } catch (err) {
        report(
          'error',
          err instanceof ApiError ? err.message : 'validation failed',
          fromPath,
          toPath,
          statusCode,
        );
        continue;
      }
      // Chains inside the batch or against existing rows would need two hops.
      if (toPath.startsWith('/') && (seen.has(toPath) || existing.has(toPath))) {
        report(
          'error',
          `target ${toPath} is itself redirected; point directly at the final destination`,
          fromPath,
          toPath,
          statusCode,
        );
        continue;
      }
      creatable.push({ fromPath, toPath, statusCode, line: row.line });
      report('create', null, fromPath, toPath, statusCode);
    }

    if (!parsed.dryRun && creatable.length > 0) {
      const inserted = await tx
        .insert(schema.redirects)
        .values(
          creatable.map((c) => ({
            fromPath: c.fromPath,
            toPath: c.toPath,
            statusCode: c.statusCode,
            active: true,
            note: 'CSV import',
            createdBy: userId,
          })),
        )
        .returning({ id: schema.redirects.id, fromPath: schema.redirects.fromPath });
      for (const row of inserted) {
        await recordAudit(tx, identity, {
          action: 'redirect.created',
          entityType: 'redirect',
          entityId: row.id,
          after: creatable.find((c) => c.fromPath === row.fromPath) ?? null,
          reason: 'csv_import',
          correlationId: options.correlationId,
        });
      }
      for (const r of out) if (r.outcome === 'create') r.outcome = 'created';
    }
    return out;
  });

  if (!parsed.dryRun) await cacheDelete('redirect');
  const count = (outcome: RedirectImportRow['outcome']) =>
    result.filter((r) => r.outcome === outcome).length;
  return {
    dryRun: parsed.dryRun,
    rows: result,
    summary: {
      total: result.length,
      create: count('create'),
      created: count('created'),
      unchanged: count('unchanged'),
      skip: count('skip'),
      error: count('error'),
    },
  };
}
