import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  ApiError,
  type PermitCreate,
  type PermitDto,
  type PermitEventCreate,
  type PermitEventDto,
  type PermitUpdate,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { permitStatusAfterEvent } from '@simplexd/domain/projects';
import { permitElapsed, type PermitEvent } from '@simplexd/domain/timelines';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, requireProject, type AccessCheck } from './access';
import {
  assertUpdatedAt,
  ctxFor,
  invalidTransition,
  notFound,
  toKobo,
  userIdOf,
  type ServiceOptions,
} from './shared';

type PermitRow = typeof schema.permitApplications.$inferSelect;
type EventRow = typeof schema.permitEvents.$inferSelect;

const ELAPSED_TYPES = new Set([
  'submitted',
  'query_raised',
  'resubmitted',
  'approved',
  'rejected',
  'withdrawn',
]);

function toEventDto(e: EventRow): PermitEventDto {
  return {
    id: e.id,
    permitApplicationId: e.permitApplicationId,
    eventType: e.eventType,
    occurredAt: e.occurredAt,
    note: e.note,
    actorUserId: e.actorUserId,
    createdAt: e.createdAt.toISOString(),
  };
}

async function toDto(tx: Transaction, p: PermitRow): Promise<PermitDto> {
  const events = await tx
    .select()
    .from(schema.permitEvents)
    .where(eq(schema.permitEvents.permitApplicationId, p.id))
    .orderBy(asc(schema.permitEvents.occurredAt), asc(schema.permitEvents.createdAt));
  const timeline: PermitEvent[] = events
    .filter((e) => ELAPSED_TYPES.has(e.eventType))
    .map((e) => ({ type: e.eventType as PermitEvent['type'], occurredAt: e.occurredAt }));
  const elapsed =
    timeline.length > 0
      ? permitElapsed({
          events: timeline,
          asOf: new Date().toISOString(),
          basis: p.statutoryTargetBasis ?? 'elapsed',
        })
      : null;
  const statutory =
    p.statutoryTargetDays !== null && p.statutoryTargetBasis !== null && p.statutorySourceNote
      ? {
          days: p.statutoryTargetDays,
          basis: p.statutoryTargetBasis,
          sourceNote: p.statutorySourceNote,
        }
      : null;
  return {
    id: p.id,
    organizationId: p.organizationId,
    projectId: p.projectId,
    propertyId: p.propertyId,
    jurisdiction: p.jurisdiction,
    authority: p.authority,
    permitType: p.permitType,
    documentType: p.documentType,
    status: p.status,
    completenessDate: p.completenessDate,
    applicationReference: p.applicationReference,
    feesKobo: p.feesKobo?.toString() ?? null,
    submittedAt: p.submittedAt,
    decidedAt: p.decidedAt,
    statutoryTarget: statutory,
    statutoryTargetStatus: statutory ? 'known' : 'unknown',
    notes: p.notes,
    elapsed: elapsed
      ? {
          basis: elapsed.basis,
          asOf: elapsed.asOf,
          applicantDays: elapsed.applicantDays,
          authorityDays: elapsed.authorityDays,
          totalDays: elapsed.totalDays,
          status: elapsed.status,
        }
      : null,
    events: events.map(toEventDto),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function loadPermit(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
  checks: AccessCheck[],
) {
  const [p] = await tx
    .select()
    .from(schema.permitApplications)
    .where(eq(schema.permitApplications.id, id));
  if (!p || !p.projectId) throw notFound('permit application');
  const access = await requireProject(tx, identity, p.projectId, checks);
  return { p, access };
}

export async function createPermit(
  identity: RequestIdentity,
  projectId: string,
  input: PermitCreate,
  options: ServiceOptions = {},
): Promise<PermitDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    const [row] = await tx
      .insert(schema.permitApplications)
      .values({
        organizationId: access.project.organizationId,
        projectId,
        propertyId: input.propertyId ?? access.project.propertyId,
        jurisdiction: input.jurisdiction,
        authority: input.authority,
        permitType: input.permitType,
        documentType: input.documentType ?? null,
        completenessDate: input.completenessDate ?? null,
        applicationReference: input.applicationReference ?? null,
        feesKobo: input.feesKobo ? toKobo(input.feesKobo) : null,
        statutoryTargetDays: input.statutoryTarget?.days ?? null,
        statutoryTargetBasis: input.statutoryTarget?.basis ?? null,
        statutorySourceNote: input.statutoryTarget?.sourceNote ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'permit.created',
      entityType: 'permit_application',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: {
        projectId,
        jurisdiction: input.jurisdiction,
        authority: input.authority,
        permitType: input.permitType,
        statutoryTarget: input.statutoryTarget ?? null,
      },
      correlationId: options.correlationId,
    });
    return toDto(tx, row!);
  });
}

export async function listPermits(
  identity: RequestIdentity,
  projectId: string,
): Promise<{ items: PermitDto[] }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const rows = await tx
      .select()
      .from(schema.permitApplications)
      .where(eq(schema.permitApplications.projectId, projectId))
      .orderBy(desc(schema.permitApplications.createdAt));
    const items: PermitDto[] = [];
    for (const r of rows) items.push(await toDto(tx, r));
    return { items };
  });
}

export async function getPermit(identity: RequestIdentity, id: string): Promise<PermitDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { p } = await loadPermit(tx, identity, id, PROJECT_READ_CHECKS);
    return toDto(tx, p);
  });
}

export async function updatePermit(
  identity: RequestIdentity,
  id: string,
  input: PermitUpdate,
  options: ServiceOptions = {},
): Promise<PermitDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { p, access } = await loadPermit(tx, identity, id, [{ staff: 'projects.manage' }]);
    assertUpdatedAt(p.updatedAt, input.expectedUpdatedAt);
    const patch: Partial<typeof schema.permitApplications.$inferInsert> = {};
    if (input.documentType !== undefined) patch.documentType = input.documentType;
    if (input.completenessDate !== undefined) patch.completenessDate = input.completenessDate;
    if (input.applicationReference !== undefined)
      patch.applicationReference = input.applicationReference;
    if (input.feesKobo !== undefined)
      patch.feesKobo = input.feesKobo ? toKobo(input.feesKobo) : null;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.statutoryTarget !== undefined) {
      patch.statutoryTargetDays = input.statutoryTarget?.days ?? null;
      patch.statutoryTargetBasis = input.statutoryTarget?.basis ?? null;
      patch.statutorySourceNote = input.statutoryTarget?.sourceNote ?? null;
    }
    const [updated] = await tx
      .update(schema.permitApplications)
      .set(patch)
      .where(eq(schema.permitApplications.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'permit.updated',
      entityType: 'permit_application',
      entityId: id,
      organizationId: access.project.organizationId,
      before: {
        statutoryTargetDays: p.statutoryTargetDays,
        applicationReference: p.applicationReference,
      },
      after: {
        statutoryTargetDays: updated!.statutoryTargetDays,
        applicationReference: updated!.applicationReference,
      },
      correlationId: options.correlationId,
    });
    return toDto(tx, updated!);
  });
}

/** Appends an event (append-only) and moves the status when the event type demands it. */
export async function addPermitEvent(
  identity: RequestIdentity,
  id: string,
  input: PermitEventCreate,
  options: ServiceOptions = {},
): Promise<PermitDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { p, access } = await loadPermit(tx, identity, id, [{ staff: 'projects.manage' }]);
    const decision = permitStatusAfterEvent(p.status, input.eventType);
    if (!decision.ok)
      throw invalidTransition(decision.message, { status: p.status, eventType: input.eventType });
    if (input.eventType === 'note' && !input.note)
      throw new ApiError('validation_failed', 'a note event needs a note');
    await tx
      .insert(schema.permitEvents)
      .values({
        permitApplicationId: id,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        note: input.note ?? null,
        actorUserId: actorId,
      });
    let current = p;
    if (decision.changed) {
      const patch: Partial<typeof schema.permitApplications.$inferInsert> = {
        status: decision.status,
      };
      if (input.eventType === 'submitted') patch.submittedAt = input.occurredAt;
      if (['approved', 'rejected', 'withdrawn'].includes(input.eventType))
        patch.decidedAt = input.occurredAt;
      if (input.eventType === 'completeness_confirmed') patch.completenessDate = input.occurredAt;
      const [updated] = await tx
        .update(schema.permitApplications)
        .set(patch)
        .where(
          and(eq(schema.permitApplications.id, id), eq(schema.permitApplications.status, p.status)),
        )
        .returning();
      if (!updated)
        throw new ApiError(
          'version_conflict',
          'the application changed while recording the event; reload',
        );
      current = updated;
    } else if (input.eventType === 'completeness_confirmed') {
      const [updated] = await tx
        .update(schema.permitApplications)
        .set({ completenessDate: input.occurredAt })
        .where(eq(schema.permitApplications.id, id))
        .returning();
      current = updated ?? p;
    }
    await recordAudit(tx, identity, {
      action: `permit.${input.eventType}`,
      entityType: 'permit_application',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: p.status },
      after: { status: current.status, occurredAt: input.occurredAt },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    return toDto(tx, current);
  });
}
