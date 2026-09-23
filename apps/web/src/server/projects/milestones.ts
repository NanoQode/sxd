import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import {
  ApiError,
  type MilestoneAcceptance,
  type MilestoneCreate,
  type MilestoneDto,
  type MilestoneFinanceAuthorization,
  type MilestoneProgress,
  type MilestoneUpdate,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { evaluateMilestoneAction, type MilestoneAction } from '@simplexd/domain/projects';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, requireProject, type AccessCheck, type ProjectAccess } from './access';
import { assertUpdatedAt, ctxFor, invalidTransition, iso, notFound, userIdOf, type ServiceOptions } from './shared';

type MilestoneRow = typeof schema.milestones.$inferSelect;

export function toMilestoneDto(m: MilestoneRow): MilestoneDto {
  return {
    id: m.id,
    projectId: m.projectId,
    name: m.name,
    description: m.description,
    plannedDate: m.plannedDate,
    forecastDate: m.forecastDate,
    status: m.status,
    inspectorProgressPct: m.inspectorProgressPct,
    inspectorProgressBy: m.inspectorProgressBy,
    inspectorProgressAt: iso(m.inspectorProgressAt),
    customerAcceptedBy: m.customerAcceptedBy,
    customerAcceptedAt: iso(m.customerAcceptedAt),
    customerRejectedReason: m.customerRejectedReason,
    financeAuthorizedBy: m.financeAuthorizedBy,
    financeAuthorizedAt: iso(m.financeAuthorizedAt),
    paymentInvoiceId: m.paymentInvoiceId,
    sortOrder: m.sortOrder,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

async function loadMilestone(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
  checks: AccessCheck[],
): Promise<{ m: MilestoneRow; access: ProjectAccess }> {
  const [m] = await tx.select().from(schema.milestones).where(eq(schema.milestones.id, id));
  if (!m) throw notFound('milestone');
  const access = await requireProject(tx, identity, m.projectId, checks);
  return { m, access };
}

export async function createMilestone(
  identity: RequestIdentity,
  projectId: string,
  input: MilestoneCreate,
  options: ServiceOptions = {},
): Promise<MilestoneDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    const [row] = await tx
      .insert(schema.milestones)
      .values({
        projectId,
        name: input.name,
        description: input.description ?? null,
        plannedDate: input.plannedDate ?? null,
        forecastDate: input.forecastDate ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'milestone.created',
      entityType: 'milestone',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: { projectId, name: input.name, plannedDate: input.plannedDate ?? null },
      correlationId: options.correlationId,
    });
    return toMilestoneDto(row!);
  });
}

export async function listMilestones(identity: RequestIdentity, projectId: string): Promise<{ items: MilestoneDto[] }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const rows = await tx
      .select()
      .from(schema.milestones)
      .where(eq(schema.milestones.projectId, projectId))
      .orderBy(asc(schema.milestones.sortOrder), asc(schema.milestones.plannedDate), asc(schema.milestones.createdAt));
    return { items: rows.map(toMilestoneDto) };
  });
}

export async function getMilestone(identity: RequestIdentity, id: string): Promise<MilestoneDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { m } = await loadMilestone(tx, identity, id, PROJECT_READ_CHECKS);
    return toMilestoneDto(m);
  });
}

export async function updateMilestone(
  identity: RequestIdentity,
  id: string,
  input: MilestoneUpdate,
  options: ServiceOptions = {},
): Promise<MilestoneDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { m, access } = await loadMilestone(tx, identity, id, [{ staff: 'projects.manage' }]);
    assertUpdatedAt(m.updatedAt, input.expectedUpdatedAt);
    if (m.status === 'accepted') throw invalidTransition('an accepted milestone cannot be edited');
    const { expectedUpdatedAt: _e, ...fields } = input;
    const patch: Partial<typeof schema.milestones.$inferInsert> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    const [updated] = await tx.update(schema.milestones).set(patch).where(eq(schema.milestones.id, id)).returning();
    await recordAudit(tx, identity, {
      action: 'milestone.updated',
      entityType: 'milestone',
      entityId: id,
      organizationId: access.project.organizationId,
      before: Object.fromEntries(Object.keys(fields).map((k) => [k, (m as Record<string, unknown>)[k] ?? null])),
      after: fields,
      correlationId: options.correlationId,
    });
    return toMilestoneDto(updated!);
  });
}

async function applyAction(
  tx: Transaction,
  identity: RequestIdentity,
  m: MilestoneRow,
  access: ProjectAccess,
  action: MilestoneAction,
  patch: Partial<typeof schema.milestones.$inferInsert>,
  ctx: { percentComplete?: number; reason?: string | null },
  options: ServiceOptions,
  eventType: string | null,
): Promise<MilestoneRow> {
  const decision = evaluateMilestoneAction(action, {
    status: m.status,
    percentComplete: ctx.percentComplete,
    reason: ctx.reason ?? null,
    financeAuthorizedAt: m.financeAuthorizedAt,
  });
  if (!decision.ok) {
    if (decision.code === 'validation_failed') throw new ApiError('validation_failed', decision.message);
    throw invalidTransition(decision.message, { from: m.status, action });
  }
  const [updated] = await tx
    .update(schema.milestones)
    .set({ ...patch, status: decision.nextStatus })
    .where(and(eq(schema.milestones.id, m.id), eq(schema.milestones.status, m.status)))
    .returning();
  if (!updated) throw new ApiError('version_conflict', 'the milestone changed while you were deciding; reload');
  await recordAudit(tx, identity, {
    action: `milestone.${action}`,
    entityType: 'milestone',
    entityId: m.id,
    organizationId: access.project.organizationId,
    before: { status: m.status },
    after: { status: decision.nextStatus, ...serializable(patch) },
    reason: ctx.reason ?? null,
    correlationId: options.correlationId,
  });
  if (eventType) {
    await appendOutbox(tx, {
      eventType,
      aggregateType: 'milestone',
      aggregateId: m.id,
      organizationId: access.project.organizationId,
      actorUserId: identity.session?.user.id ?? null,
      payload: {
        projectId: m.projectId,
        milestoneId: m.id,
        status: decision.nextStatus,
        pmUserId: access.project.pmUserId,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
  }
  return updated;
}

function serializable(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/** Inspector's progress estimate (`milestones.record_progress`); never implies acceptance. */
export async function recordMilestoneProgress(
  identity: RequestIdentity,
  id: string,
  input: MilestoneProgress,
  options: ServiceOptions = {},
): Promise<MilestoneDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { m, access } = await loadMilestone(tx, identity, id, [{ staff: 'milestones.record_progress' }]);
    const updated = await applyAction(
      tx,
      identity,
      m,
      access,
      'record_progress',
      { inspectorProgressPct: input.percentComplete, inspectorProgressBy: actorId, inspectorProgressAt: new Date() },
      { percentComplete: input.percentComplete, reason: input.note ?? null },
      options,
      null,
    );
    return toMilestoneDto(updated);
  });
}

/** Presents the milestone to the customer for acceptance. */
export async function submitMilestone(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<MilestoneDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { m, access } = await loadMilestone(tx, identity, id, [{ staff: 'projects.manage' }]);
    const updated = await applyAction(tx, identity, m, access, 'submit', {}, {}, options, 'project.milestone.submitted');
    return toMilestoneDto(updated);
  });
}

/** Customer acceptance or rejection (`org.milestones.accept`); distinct from progress and finance. */
export async function decideMilestone(
  identity: RequestIdentity,
  id: string,
  input: MilestoneAcceptance,
  options: ServiceOptions = {},
): Promise<MilestoneDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { m, access } = await loadMilestone(tx, identity, id, [{ org: 'org.milestones.accept' }]);
    const updated =
      input.decision === 'accepted'
        ? await applyAction(
            tx,
            identity,
            m,
            access,
            'accept',
            { customerAcceptedBy: actorId, customerAcceptedAt: new Date(), customerRejectedReason: null },
            {},
            options,
            'project.milestone.accepted',
          )
        : await applyAction(
            tx,
            identity,
            m,
            access,
            'reject',
            { customerRejectedReason: input.reason ?? null },
            { reason: input.reason ?? null },
            options,
            'project.milestone.rejected',
          );
    return toMilestoneDto(updated);
  });
}

/** Staff restart work after a customer rejection. */
export async function reworkMilestone(identity: RequestIdentity, id: string, options: ServiceOptions = {}): Promise<MilestoneDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { m, access } = await loadMilestone(tx, identity, id, [{ staff: 'projects.manage' }]);
    const updated = await applyAction(tx, identity, m, access, 'rework', {}, {}, options, null);
    return toMilestoneDto(updated);
  });
}

/**
 * Finance's payment authorisation (`milestones.finance_authorize`). Requires a
 * verified authenticator (brief §11: MFA for finance permissions) and a
 * customer-accepted milestone; it never records acceptance itself.
 */
export async function authorizeMilestonePayment(
  identity: RequestIdentity,
  id: string,
  input: MilestoneFinanceAuthorization,
  options: ServiceOptions = {},
): Promise<MilestoneDto> {
  const actorId = userIdOf(identity);
  if (!identity.actor.mfaVerified) {
    throw new ApiError('mfa_required', 'payment authorisation requires a verified authenticator');
  }
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { m, access } = await loadMilestone(tx, identity, id, [{ staff: 'milestones.finance_authorize' }]);
    const updated = await applyAction(
      tx,
      identity,
      m,
      access,
      'finance_authorize',
      { financeAuthorizedBy: actorId, financeAuthorizedAt: new Date(), paymentInvoiceId: input.paymentInvoiceId ?? m.paymentInvoiceId },
      { reason: input.note ?? null },
      options,
      'project.milestone.payment_authorized',
    );
    return toMilestoneDto(updated);
  });
}
