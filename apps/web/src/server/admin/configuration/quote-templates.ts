import 'server-only';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import {
  ApiError,
  type QuoteLineInput,
  type QuoteTemplateCreate,
  type QuoteTemplatePatch,
} from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import { lineAmountKobo, sumKobo } from '@/lib/admin/money';
import {
  actorId,
  assertUpdatedAt,
  authorize,
  changedFields,
  notFound,
  transact,
  type AdminContext,
} from '../context';
import { authorizeAny, serviceNames } from './shared';

/**
 * Quotation templates: reusable lines, scope and exclusions per service (or
 * for every service). Staff start a quote from a template and edit the lines;
 * the issued quote is its own versioned record, so editing or retiring a
 * template never changes a quote already drafted or issued. Reading needs
 * `pricing.manage` or `quotes.issue`; writing needs `pricing.manage`.
 */

type TemplateRow = typeof schema.quoteTemplates.$inferSelect;
type QuoteLine = TemplateRow['lines'][number];

export interface QuoteTemplateDto {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  name: string;
  lines: QuoteLine[];
  subtotalKobo: string;
  scopeMarkdown: string | null;
  exclusions: string | null;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Stored lines carry the amount computed with the same half-up rounding the quote engine uses. */
export function toStoredLines(lines: QuoteLineInput[]): QuoteLine[] {
  return lines.map((l) => {
    const quantity = l.quantity ?? '1';
    return {
      description: l.description.trim(),
      quantity,
      unitAmountKobo: l.unitAmountKobo,
      amountKobo: lineAmountKobo(quantity, l.unitAmountKobo),
      ...(l.taxRateBps !== undefined ? { taxRateBps: l.taxRateBps } : {}),
      ...(l.accountCode ? { accountCode: l.accountCode } : {}),
    };
  });
}

function toDto(r: TemplateRow, names: Map<string, string>): QuoteTemplateDto {
  const lines = Array.isArray(r.lines) ? r.lines : [];
  return {
    id: r.id,
    serviceId: r.serviceId,
    serviceName: r.serviceId ? (names.get(r.serviceId) ?? null) : null,
    name: r.name,
    lines,
    subtotalKobo: sumKobo(lines.map((l) => l.amountKobo)),
    scopeMarkdown: r.scopeMarkdown,
    exclusions: r.exclusions,
    active: r.active,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Unit amounts are prices; a negative template line is always a mistake. */
function assertLines(lines: QuoteLineInput[]): void {
  lines.forEach((l, i) => {
    if (l.unitAmountKobo.startsWith('-'))
      throw new ApiError('validation_failed', `line ${i + 1}: unit amount cannot be negative`);
  });
}

async function assertService(tx: Transaction, serviceId: string | null): Promise<void> {
  if (!serviceId) return;
  const [svc] = await tx
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(eq(schema.services.id, serviceId));
  if (!svc) throw notFound('service');
}

export async function listQuoteTemplates(
  ctx: AdminContext,
  query: { serviceId?: string; active?: 'true' | 'false' | 'all' } = {},
): Promise<QuoteTemplateDto[]> {
  authorizeAny(ctx, ['pricing.manage', 'quotes.issue']);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.quoteTemplates)
      .where(
        and(
          query.serviceId
            ? or(
                eq(schema.quoteTemplates.serviceId, query.serviceId),
                isNull(schema.quoteTemplates.serviceId),
              )
            : undefined,
          query.active === 'true'
            ? eq(schema.quoteTemplates.active, true)
            : query.active === 'false'
              ? eq(schema.quoteTemplates.active, false)
              : undefined,
        ),
      )
      .orderBy(asc(schema.quoteTemplates.name));
    const names = await serviceNames(
      tx,
      rows.map((r) => r.serviceId),
    );
    return rows.map((r) => toDto(r, names));
  });
}

export async function getQuoteTemplate(ctx: AdminContext, id: string): Promise<QuoteTemplateDto> {
  authorizeAny(ctx, ['pricing.manage', 'quotes.issue']);
  return transact(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.quoteTemplates)
      .where(eq(schema.quoteTemplates.id, id));
    if (!row) throw notFound('quote template');
    return toDto(row, await serviceNames(tx, [row.serviceId]));
  });
}

export async function createQuoteTemplate(
  ctx: AdminContext,
  input: QuoteTemplateCreate,
): Promise<QuoteTemplateDto> {
  authorize(ctx, 'pricing.manage');
  const userId = actorId(ctx);
  assertLines(input.lines);
  return transact(ctx, async (tx) => {
    await assertService(tx, input.serviceId);
    const [row] = await tx
      .insert(schema.quoteTemplates)
      .values({
        serviceId: input.serviceId,
        name: input.name,
        lines: toStoredLines(input.lines),
        scopeMarkdown: input.scopeMarkdown ?? null,
        exclusions: input.exclusions ?? null,
        active: input.active ?? true,
        createdBy: userId,
      })
      .returning();
    const dto = toDto(row!, await serviceNames(tx, [row!.serviceId]));
    await recordAudit(tx, ctx.identity, {
      action: 'quote_template.created',
      entityType: 'quote_template',
      entityId: row!.id,
      after: dto,
      correlationId: ctx.correlationId,
    });
    return dto;
  });
}

export async function patchQuoteTemplate(
  ctx: AdminContext,
  id: string,
  input: QuoteTemplatePatch,
): Promise<QuoteTemplateDto> {
  authorize(ctx, 'pricing.manage');
  if (input.lines) assertLines(input.lines);
  return transact(ctx, async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.quoteTemplates)
      .where(eq(schema.quoteTemplates.id, id))
      .for('update');
    if (!current) throw notFound('quote template');
    assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    if (input.serviceId !== undefined) await assertService(tx, input.serviceId);
    const [updated] = await tx
      .update(schema.quoteTemplates)
      .set({
        ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.lines !== undefined ? { lines: toStoredLines(input.lines) } : {}),
        ...(input.scopeMarkdown !== undefined ? { scopeMarkdown: input.scopeMarkdown } : {}),
        ...(input.exclusions !== undefined ? { exclusions: input.exclusions } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(schema.quoteTemplates.id, id))
      .returning();
    const names = await serviceNames(tx, [current.serviceId, updated!.serviceId]);
    const diff = changedFields(
      toDto(current, names) as unknown as Record<string, unknown>,
      toDto(updated!, names) as unknown as Record<string, unknown>,
    );
    delete diff.before.updatedAt;
    delete diff.after.updatedAt;
    await recordAudit(tx, ctx.identity, {
      action:
        input.active === false && current.active
          ? 'quote_template.deactivated'
          : 'quote_template.updated',
      entityType: 'quote_template',
      entityId: id,
      before: diff.before,
      after: diff.after,
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!, names);
  });
}
