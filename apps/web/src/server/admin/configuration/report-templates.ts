import 'server-only';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { ApiError, type ReportTemplateCreate, type ReportTemplatePatch } from '@simplexd/contracts';
import { schema, type DbExecutor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import {
  actorId,
  authorize,
  changedFields,
  notFound,
  transact,
  versionConflict,
  type AdminContext,
} from '../context';
import { authorizeAny, lockKey } from './shared';

/**
 * Report templates: ordered section outlines and standard scope/limitations
 * wording per report kind. Exactly one template per kind may be active; the
 * report authoring flow starts a new report from it and keeps its own copy,
 * so editing a template never rewrites an existing report. Reading needs a
 * report permission; writing needs `reports.review`.
 */

type TemplateRow = typeof schema.reportTemplates.$inferSelect;
export type ReportKind = TemplateRow['kind'];

export interface ReportTemplateSectionDto {
  key: string;
  heading: string;
  guidance?: string;
  required: boolean;
}

export interface ReportTemplateDto {
  id: string;
  kind: ReportKind;
  name: string;
  sections: ReportTemplateSectionDto[];
  limitationsMarkdown: string | null;
  active: boolean;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const READ_PERMISSIONS = ['reports.draft', 'reports.review', 'reports.release'] as const;

function toDto(r: TemplateRow): ReportTemplateDto {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    sections: Array.isArray(r.sections) ? r.sections : [],
    limitationsMarkdown: r.limitationsMarkdown,
    active: r.active,
    version: r.version,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function cleanSections(sections: ReportTemplateCreate['sections']): ReportTemplateSectionDto[] {
  const keys = new Set<string>();
  for (const s of sections) {
    if (keys.has(s.key))
      throw new ApiError('validation_failed', `duplicate section key "${s.key}"`);
    keys.add(s.key);
  }
  if (sections.length === 0)
    throw new ApiError('validation_failed', 'at least one section is required');
  return sections.map((s) => ({
    key: s.key,
    heading: s.heading.trim(),
    ...(s.guidance && s.guidance.trim() ? { guidance: s.guidance.trim() } : {}),
    required: s.required,
  }));
}

/**
 * The active template for a report kind, or null when none is active. For the
 * report authoring flow: call inside the caller's transaction.
 */
export async function activeReportTemplate(
  tx: DbExecutor,
  kind: ReportKind,
): Promise<ReportTemplateDto | null> {
  const [row] = await tx
    .select()
    .from(schema.reportTemplates)
    .where(and(eq(schema.reportTemplates.kind, kind), eq(schema.reportTemplates.active, true)))
    .orderBy(desc(schema.reportTemplates.updatedAt))
    .limit(1);
  return row ? toDto(row) : null;
}

/** Deactivates every other active template of the kind; returns the ids it switched off. */
async function deactivateOthers(
  tx: Transaction,
  kind: ReportKind,
  keepId: string,
): Promise<string[]> {
  const rows = await tx
    .update(schema.reportTemplates)
    .set({ active: false, version: sql`${schema.reportTemplates.version} + 1` })
    .where(
      and(
        eq(schema.reportTemplates.kind, kind),
        eq(schema.reportTemplates.active, true),
        ne(schema.reportTemplates.id, keepId),
      ),
    )
    .returning({ id: schema.reportTemplates.id });
  return rows.map((r) => r.id);
}

export async function listReportTemplates(
  ctx: AdminContext,
  query: { kind?: ReportKind } = {},
): Promise<ReportTemplateDto[]> {
  authorizeAny(ctx, [...READ_PERMISSIONS]);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.reportTemplates)
      .where(query.kind ? eq(schema.reportTemplates.kind, query.kind) : undefined)
      .orderBy(
        asc(schema.reportTemplates.kind),
        desc(schema.reportTemplates.active),
        asc(schema.reportTemplates.name),
      );
    return rows.map(toDto);
  });
}

export async function getReportTemplate(ctx: AdminContext, id: string): Promise<ReportTemplateDto> {
  authorizeAny(ctx, [...READ_PERMISSIONS]);
  return transact(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.reportTemplates)
      .where(eq(schema.reportTemplates.id, id));
    if (!row) throw notFound('report template');
    return toDto(row);
  });
}

export async function createReportTemplate(
  ctx: AdminContext,
  input: ReportTemplateCreate,
): Promise<ReportTemplateDto> {
  authorize(ctx, 'reports.review');
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    await lockKey(tx, `report_templates:${input.kind}`);
    const [row] = await tx
      .insert(schema.reportTemplates)
      .values({
        kind: input.kind,
        name: input.name,
        sections: cleanSections(input.sections),
        limitationsMarkdown: input.limitationsMarkdown,
        active: input.active ?? false,
        createdBy: userId,
      })
      .returning();
    const deactivated = row!.active ? await deactivateOthers(tx, row!.kind, row!.id) : [];
    await recordAudit(tx, ctx.identity, {
      action: 'report_template.created',
      entityType: 'report_template',
      entityId: row!.id,
      after: { ...toDto(row!), deactivatedTemplateIds: deactivated },
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
    });
    return toDto(row!);
  });
}

export async function patchReportTemplate(
  ctx: AdminContext,
  id: string,
  input: ReportTemplatePatch,
): Promise<ReportTemplateDto> {
  authorize(ctx, 'reports.review');
  return transact(ctx, async (tx) => {
    const [peek] = await tx
      .select({ kind: schema.reportTemplates.kind })
      .from(schema.reportTemplates)
      .where(eq(schema.reportTemplates.id, id));
    if (!peek) throw notFound('report template');
    await lockKey(tx, `report_templates:${peek.kind}`);
    const [current] = await tx
      .select()
      .from(schema.reportTemplates)
      .where(eq(schema.reportTemplates.id, id))
      .for('update');
    if (!current) throw notFound('report template');
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const nothing =
      input.name === undefined &&
      input.sections === undefined &&
      input.limitationsMarkdown === undefined &&
      input.active === undefined;
    if (nothing) throw new ApiError('validation_failed', 'nothing to change');
    const [updated] = await tx
      .update(schema.reportTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sections !== undefined ? { sections: cleanSections(input.sections) } : {}),
        ...(input.limitationsMarkdown !== undefined
          ? { limitationsMarkdown: input.limitationsMarkdown }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: current.version + 1,
      })
      .where(
        and(eq(schema.reportTemplates.id, id), eq(schema.reportTemplates.version, current.version)),
      )
      .returning();
    if (!updated) throw versionConflict(current.version);
    const deactivated =
      updated.active && !current.active ? await deactivateOthers(tx, updated.kind, id) : [];
    const diff = changedFields(
      toDto(current) as unknown as Record<string, unknown>,
      toDto(updated) as unknown as Record<string, unknown>,
    );
    delete diff.before.updatedAt;
    delete diff.after.updatedAt;
    await recordAudit(tx, ctx.identity, {
      action:
        input.active === true && !current.active
          ? 'report_template.activated'
          : input.active === false && current.active
            ? 'report_template.deactivated'
            : 'report_template.updated',
      entityType: 'report_template',
      entityId: id,
      before: diff.before,
      after: { ...diff.after, deactivatedTemplateIds: deactivated },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    return toDto(updated);
  });
}
