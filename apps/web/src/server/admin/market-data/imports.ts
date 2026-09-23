import 'server-only';
import { parse } from 'csv-parse/sync';
import { desc, eq } from 'drizzle-orm';
import {
  ApiError,
  observationCreateInputSchema,
  type ImportDto,
  type ImportPreviewRequest,
  type ObservationCreateInput,
} from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { importMarketSeed, type ImportSummary } from '@simplexd/db/seed';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import { actorId, authorize, iso, notFound, transact, type AdminContext } from '../context';
import { createObservation } from './observations';

type ImportRow = typeof schema.marketImports.$inferSelect;

interface RowError {
  row: number | null;
  path: string;
  message: string;
}

/** Stored inside `summary` so an apply can replay exactly what was previewed. */
interface StoredPayload {
  seed?: unknown;
  observations?: ObservationCreateInput[];
}

function toDto(r: ImportRow, uploadedByName: string | null): ImportDto {
  const { payload: _payload, ...summary } = (r.summary ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    fileName: r.fileName,
    format: r.format,
    status: r.status,
    summary,
    rowErrors: (r.rowErrors as RowError[]) ?? [],
    conflicts: (r.conflicts as ImportDto['conflicts']) ?? [],
    uploadedBy: r.uploadedBy,
    uploadedByName,
    appliedAt: iso(r.appliedAt),
    appliedBy: r.appliedBy,
    createdAt: r.createdAt.toISOString(),
  };
}

/* ---------------------------------------------------------------------- */
/* CSV parsing                                                             */
/* ---------------------------------------------------------------------- */

const NUMERIC_COLUMNS = new Set(['value', 'valueLow', 'valueHigh', 'sampleSize']);
const BOOLEAN_COLUMNS = new Set(['periodCompleteAtRetrieval']);
const CONVENIENCE_COLUMNS = new Set(['sourceSlug', 'marketSlug', 'stateName']);

export const OBSERVATION_CSV_COLUMNS = [
  ...Object.keys(observationCreateInputSchema.shape),
  'sourceSlug',
  'marketSlug',
  'stateName',
];

function coerceCell(column: string, raw: string): unknown {
  const value = raw.trim();
  if (value === '') return undefined;
  if (NUMERIC_COLUMNS.has(column)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (BOOLEAN_COLUMNS.has(column)) {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
    return value;
  }
  return value;
}

interface Lookups {
  sourceBySlug: Map<string, string>;
  marketBySlug: Map<string, string>;
  stateByName: Map<string, string>;
}

async function loadLookups(tx: Transaction): Promise<Lookups> {
  const [sources, markets, states] = await Promise.all([
    tx.select({ slug: schema.sources.slug, id: schema.sources.id }).from(schema.sources),
    tx.select({ slug: schema.markets.slug, id: schema.markets.id }).from(schema.markets),
    tx.select({ name: schema.states.name, id: schema.states.id }).from(schema.states),
  ]);
  return {
    sourceBySlug: new Map(sources.map((s) => [s.slug, s.id])),
    marketBySlug: new Map(markets.map((m) => [m.slug, m.id])),
    stateByName: new Map(states.map((s) => [s.name.toLowerCase(), s.id])),
  };
}

export function parseObservationCsv(
  content: string,
  lookups: Lookups,
): { rows: ObservationCreateInput[]; errors: RowError[]; total: number } {
  let records: Array<Record<string, string>>;
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    return {
      rows: [],
      errors: [
        {
          row: null,
          path: 'file',
          message: err instanceof Error ? err.message : 'CSV could not be parsed',
        },
      ],
      total: 0,
    };
  }
  const rows: ObservationCreateInput[] = [];
  const errors: RowError[] = [];
  const header = Object.keys(records[0] ?? {});
  const unknownColumns = header.filter((h) => !OBSERVATION_CSV_COLUMNS.includes(h));
  if (unknownColumns.length > 0)
    errors.push({
      row: null,
      path: 'header',
      message: `unknown column(s) ignored: ${unknownColumns.join(', ')}`,
    });
  records.forEach((record, index) => {
    const rowNumber = index + 2; // 1-based, after the header line
    const candidate: Record<string, unknown> = {};
    for (const [column, raw] of Object.entries(record)) {
      if (!OBSERVATION_CSV_COLUMNS.includes(column) || CONVENIENCE_COLUMNS.has(column)) continue;
      const v = coerceCell(column, raw ?? '');
      if (v !== undefined) candidate[column] = v;
    }
    const sourceSlug = record['sourceSlug']?.trim();
    if (sourceSlug && !candidate['sourceId']) {
      const id = lookups.sourceBySlug.get(sourceSlug);
      if (!id)
        errors.push({
          row: rowNumber,
          path: 'sourceSlug',
          message: `unknown source ${sourceSlug}`,
        });
      else candidate['sourceId'] = id;
    }
    const marketSlug = record['marketSlug']?.trim();
    if (marketSlug && !candidate['marketId']) {
      const id = lookups.marketBySlug.get(marketSlug);
      if (!id)
        errors.push({
          row: rowNumber,
          path: 'marketSlug',
          message: `unknown market ${marketSlug}`,
        });
      else candidate['marketId'] = id;
    }
    const stateName = record['stateName']?.trim();
    if (stateName && !candidate['stateId']) {
      const id = lookups.stateByName.get(stateName.toLowerCase());
      if (!id)
        errors.push({ row: rowNumber, path: 'stateName', message: `unknown state ${stateName}` });
      else candidate['stateId'] = id;
    }
    const parsed = observationCreateInputSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        errors.push({ row: rowNumber, path: issue.path.join('.'), message: issue.message });
      return;
    }
    if (errors.some((e) => e.row === rowNumber)) return;
    rows.push(parsed.data);
  });
  return { rows, errors, total: records.length };
}

/* ---------------------------------------------------------------------- */
/* Preview, apply, history                                                 */
/* ---------------------------------------------------------------------- */

function seedSummary(summary: ImportSummary): Record<string, unknown> {
  const { issues: _issues, conflicts: _conflicts, ...rest } = summary;
  return { ...rest };
}

export async function previewImport(
  ctx: AdminContext,
  input: ImportPreviewRequest,
): Promise<ImportDto> {
  authorize(ctx, 'market_data.import');
  const userId = actorId(ctx);
  let summary: Record<string, unknown>;
  let rowErrors: RowError[] = [];
  let conflicts: ImportDto['conflicts'] = [];
  let payload: StoredPayload;

  if (input.format === 'seed_json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch {
      throw new ApiError('validation_failed', 'the file is not valid JSON');
    }
    const result = await importMarketSeed(ctx.db, parsed, { dryRun: true, actorUserId: userId });
    summary = { format: input.format, ...seedSummary(result) };
    rowErrors = result.issues.map((i) => ({ row: null, path: i.path, message: i.message }));
    conflicts = result.conflicts;
    payload = { seed: parsed };
  } else {
    const parsed = await transact(ctx, async (tx) =>
      parseObservationCsv(input.content, await loadLookups(tx)),
    );
    summary = {
      format: input.format,
      rows: parsed.total,
      valid: parsed.rows.length,
      invalid: parsed.total - parsed.rows.length,
    };
    rowErrors = parsed.errors;
    payload = { observations: parsed.rows };
  }

  return transact(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.marketImports)
      .values({
        uploadedBy: userId,
        fileName: input.fileName,
        format: input.format,
        status: 'previewed',
        summary: { ...summary, payload },
        rowErrors,
        conflicts,
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'market_import.previewed',
      entityType: 'market_import',
      entityId: row!.id,
      after: {
        fileName: input.fileName,
        format: input.format,
        summary,
        rowErrors: rowErrors.length,
        conflicts: conflicts.length,
      },
      correlationId: ctx.correlationId,
    });
    return toDto(row!, ctx.identity.session?.user.name ?? null);
  });
}

export async function applyImport(
  ctx: AdminContext,
  id: string,
  input: { reason?: string } = {},
): Promise<ImportDto> {
  authorize(ctx, 'market_data.import');
  const userId = actorId(ctx);
  const row = await transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.marketImports)
      .where(eq(schema.marketImports.id, id));
    if (!rows[0]) throw notFound('import');
    return rows[0];
  });
  if (row.status !== 'previewed')
    throw new ApiError(
      'invalid_transition',
      `import is ${row.status}; only previewed imports can be applied`,
    );
  const stored = (row.summary as { payload?: StoredPayload }).payload ?? {};
  const { payload: _p, ...previewSummary } = row.summary as Record<string, unknown>;
  let applied: Record<string, unknown>;
  let conflicts: ImportDto['conflicts'] = [];
  let rowErrors: RowError[] = (row.rowErrors as RowError[]) ?? [];
  let touchedPublic = false;

  try {
    if (row.format === 'seed_json') {
      const blockingIssues = rowErrors.length > 0;
      if (blockingIssues)
        throw new ApiError(
          'validation_failed',
          'the seed file has validation issues; fix them and preview again',
        );
      const result = await importMarketSeed(ctx.db, stored.seed, { actorUserId: userId });
      applied = seedSummary(result);
      conflicts = result.conflicts;
      rowErrors = result.issues.map((i) => ({ row: null, path: i.path, message: i.message }));
      touchedPublic = result.markets.updated > 0 || result.sources.updated > 0;
    } else {
      const inputs = stored.observations ?? [];
      const created: string[] = [];
      let skipped = 0;
      await transact(ctx, async (tx) => {
        for (const obs of inputs) {
          if (obs.slug) {
            const dup = await tx
              .select({ id: schema.observations.id })
              .from(schema.observations)
              .where(eq(schema.observations.slug, obs.slug));
            if (dup.length > 0) {
              skipped += 1;
              continue;
            }
          }
          const dto = await createObservation(ctx, obs, {
            tx,
            auditReason: `CSV import ${row.fileName}`,
          });
          created.push(dto.id);
        }
      });
      applied = { rows: inputs.length, created: created.length, skippedExisting: skipped };
    }
  } catch (err) {
    await transact(ctx, async (tx) => {
      await tx
        .update(schema.marketImports)
        .set({
          status: 'failed',
          summary: { ...previewSummary, error: err instanceof Error ? err.message : String(err) },
        })
        .where(eq(schema.marketImports.id, id));
    });
    throw err;
  }

  const updated = await transact(ctx, async (tx) => {
    const [updated] = await tx
      .update(schema.marketImports)
      .set({
        status: 'applied',
        summary: { ...previewSummary, applied },
        conflicts,
        rowErrors,
        appliedAt: new Date(),
        appliedBy: userId,
      })
      .where(eq(schema.marketImports.id, id))
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'market_import.applied',
      entityType: 'market_import',
      entityId: id,
      before: { status: 'previewed' },
      after: { status: 'applied', applied, conflicts: conflicts.length },
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
    });
    return updated!;
  });
  if (touchedPublic) await cacheDelete('markets');
  return toDto(updated, ctx.identity.session?.user.name ?? null);
}

export async function listImports(ctx: AdminContext): Promise<ImportDto[]> {
  authorize(ctx, 'market_data.import');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select({ row: schema.marketImports, uploadedByName: schema.user.name })
      .from(schema.marketImports)
      .leftJoin(schema.user, eq(schema.user.id, schema.marketImports.uploadedBy))
      .orderBy(desc(schema.marketImports.createdAt))
      .limit(100);
    return rows.map((r) => toDto(r.row, r.uploadedByName));
  });
}

export async function getImport(ctx: AdminContext, id: string): Promise<ImportDto> {
  authorize(ctx, 'market_data.import');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select({ row: schema.marketImports, uploadedByName: schema.user.name })
      .from(schema.marketImports)
      .leftJoin(schema.user, eq(schema.user.id, schema.marketImports.uploadedBy))
      .where(eq(schema.marketImports.id, id));
    if (!rows[0]) throw notFound('import');
    return toDto(rows[0].row, rows[0].uploadedByName);
  });
}
