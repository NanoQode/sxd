import 'server-only';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import {
  ApiError,
  type DocumentRequirementCreate,
  type DocumentRequirementPatch,
} from '@simplexd/contracts';
import { anonymousContext, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { cacheDelete, cached } from '@/lib/cache';
import {
  publicRequirements,
  type EngagementStage,
  type RequirementLike,
} from '@/lib/services/document-requirements';
import {
  actorId,
  authorize,
  changedFields,
  notFound,
  transact,
  versionConflict,
  type AdminContext,
} from '../context';
import { authorizeAny, serviceNames } from './shared';

/**
 * Document requirements: what each service asks the customer for, from which
 * engagement stage, whether it is required and whether it is sensitive
 * (identity papers are requested only when the transaction needs them).
 * Published guidance (public read); staff with `pricing.manage` edit it.
 */

type RequirementRow = typeof schema.documentRequirements.$inferSelect;

export interface DocumentRequirementDto extends RequirementLike {
  serviceName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function toDto(r: RequirementRow, names: Map<string, string>): DocumentRequirementDto {
  return {
    id: r.id,
    serviceId: r.serviceId,
    serviceName: r.serviceId ? (names.get(r.serviceId) ?? null) : null,
    name: r.name,
    description: r.description,
    stage: r.stage as EngagementStage | null,
    required: r.required,
    sensitive: r.sensitive,
    active: r.active,
    sortOrder: r.sortOrder,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const TERMINAL_STAGES = new Set(['completed', 'rejected', 'cancelled', 'paused']);

function assertStage(stage: string | null | undefined): void {
  if (stage && TERMINAL_STAGES.has(stage))
    throw new ApiError(
      'validation_failed',
      `documents cannot be requested from the ${stage} stage; choose a pipeline stage`,
    );
}

async function assertService(tx: Transaction, serviceId: string | null): Promise<void> {
  if (!serviceId) return;
  const [svc] = await tx
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(eq(schema.services.id, serviceId));
  if (!svc) throw notFound('service');
}

export async function listDocumentRequirements(
  ctx: AdminContext,
  query: { serviceId?: string | 'all'; active?: 'true' | 'false' | 'all' } = {},
): Promise<DocumentRequirementDto[]> {
  authorizeAny(ctx, ['pricing.manage', 'service_requests.read_all']);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.documentRequirements)
      .where(
        and(
          query.serviceId === 'all'
            ? isNull(schema.documentRequirements.serviceId)
            : query.serviceId
              ? eq(schema.documentRequirements.serviceId, query.serviceId)
              : undefined,
          query.active === 'true'
            ? eq(schema.documentRequirements.active, true)
            : query.active === 'false'
              ? eq(schema.documentRequirements.active, false)
              : undefined,
        ),
      )
      .orderBy(
        asc(schema.documentRequirements.serviceId),
        asc(schema.documentRequirements.sortOrder),
        asc(schema.documentRequirements.name),
      );
    const names = await serviceNames(
      tx,
      rows.map((r) => r.serviceId),
    );
    return rows.map((r) => toDto(r, names));
  });
}

export async function createDocumentRequirement(
  ctx: AdminContext,
  input: DocumentRequirementCreate,
): Promise<DocumentRequirementDto> {
  authorize(ctx, 'pricing.manage');
  const userId = actorId(ctx);
  assertStage(input.stage);
  const created = await transact(ctx, async (tx) => {
    await assertService(tx, input.serviceId);
    const [row] = await tx
      .insert(schema.documentRequirements)
      .values({
        serviceId: input.serviceId,
        name: input.name,
        description: input.description ?? null,
        stage: input.stage ?? null,
        required: input.required ?? true,
        sensitive: input.sensitive ?? false,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdBy: userId,
      })
      .returning();
    const dto = toDto(row!, await serviceNames(tx, [row!.serviceId]));
    await recordAudit(tx, ctx.identity, {
      action: 'document_requirement.created',
      entityType: 'document_requirement',
      entityId: row!.id,
      after: dto,
      correlationId: ctx.correlationId,
    });
    return dto;
  });
  await cacheDelete('services:requirements:');
  return created;
}

export async function patchDocumentRequirement(
  ctx: AdminContext,
  id: string,
  input: DocumentRequirementPatch,
): Promise<DocumentRequirementDto> {
  authorize(ctx, 'pricing.manage');
  assertStage(input.stage);
  const result = await transact(ctx, async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.documentRequirements)
      .where(eq(schema.documentRequirements.id, id))
      .for('update');
    if (!current) throw notFound('document requirement');
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (input.serviceId !== undefined) await assertService(tx, input.serviceId);
    const [updated] = await tx
      .update(schema.documentRequirements)
      .set({
        ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
        ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        version: current.version + 1,
      })
      .where(
        and(
          eq(schema.documentRequirements.id, id),
          eq(schema.documentRequirements.version, current.version),
        ),
      )
      .returning();
    if (!updated) throw versionConflict(current.version);
    const names = await serviceNames(tx, [current.serviceId, updated.serviceId]);
    const diff = changedFields(
      toDto(current, names) as unknown as Record<string, unknown>,
      toDto(updated, names) as unknown as Record<string, unknown>,
    );
    delete diff.before.updatedAt;
    delete diff.after.updatedAt;
    await recordAudit(tx, ctx.identity, {
      action: 'document_requirement.updated',
      entityType: 'document_requirement',
      entityId: id,
      before: diff.before,
      after: diff.after,
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    return toDto(updated, names);
  });
  await cacheDelete('services:requirements:');
  return result;
}

/* ---------------------------------------------------------------------- */
/* Customer-facing reads                                                   */
/* ---------------------------------------------------------------------- */

async function activeForService(
  tx: Transaction,
  serviceId: string,
): Promise<DocumentRequirementDto[]> {
  const rows = await tx
    .select()
    .from(schema.documentRequirements)
    .where(
      and(
        eq(schema.documentRequirements.active, true),
        or(
          eq(schema.documentRequirements.serviceId, serviceId),
          isNull(schema.documentRequirements.serviceId),
        ),
      ),
    );
  return rows.map((r) => toDto(r, new Map()));
}

/** Public "What you'll need" list for a service page: active and non-sensitive only (cached 60 s). */
export async function publicDocumentRequirements(
  serviceId: string,
): Promise<
  Array<Pick<DocumentRequirementDto, 'id' | 'name' | 'description' | 'stage' | 'required'>>
> {
  return cached(`services:requirements:${serviceId}`, 60, async () => {
    const rows = await withActor(getDb(), anonymousContext, (tx) =>
      activeForService(tx, serviceId),
    );
    return publicRequirements(rows, serviceId).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      stage: r.stage,
      required: r.required,
    }));
  });
}

/**
 * Every active requirement that applies to a service, including sensitive
 * ones, for a signed-in customer viewing their own request (the caller has
 * already authorised access to the request).
 */
export async function requirementsForCustomer(
  identity: RequestIdentity,
  serviceId: string,
): Promise<DocumentRequirementDto[]> {
  return withActor(getDb(), identity.ctx, (tx) => activeForService(tx, serviceId));
}
