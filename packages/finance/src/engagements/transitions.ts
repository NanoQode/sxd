import { and, eq } from 'drizzle-orm';
import { ApiError, type EngagementTransitionResult } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import {
  engagementMachine,
  evaluateTransition,
  type ActorKind,
  type EngagementState,
} from '@simplexd/domain/workflow';
import { actorKindOf, type FinanceActor } from '../actor';
import { emitEvent, recordAudit } from '../audit';

export type ServiceRequestRow = typeof schema.serviceRequests.$inferSelect;

export interface EngagementTransitionInput {
  sr: ServiceRequestRow;
  to: EngagementState;
  reason?: string | null;
  /** Defaults to the caller's kind; system transitions pass 'system'. */
  actorKind?: ActorKind;
  metadata?: Record<string, unknown>;
  /** Optimistic concurrency: the version the caller loaded. */
  expectedVersion?: number;
  /** Extra columns to set alongside the status (assignment, SLA, reasons). */
  patch?: Partial<typeof schema.serviceRequests.$inferInsert>;
}

export async function loadServiceRequestForUpdate(
  tx: Transaction,
  id: string,
): Promise<ServiceRequestRow> {
  const [row] = await tx
    .select()
    .from(schema.serviceRequests)
    .where(eq(schema.serviceRequests.id, id))
    .for('update');
  if (!row) throw new ApiError('not_found', 'request not found');
  return row;
}

export function toTransitionResult(sr: ServiceRequestRow): EngagementTransitionResult {
  return {
    id: sr.id,
    reference: sr.reference,
    status: sr.status,
    version: sr.version,
    assignedPmUserId: sr.assignedPmUserId,
    priority: sr.priority,
    slaDueAt: sr.slaDueAt?.toISOString() ?? null,
  };
}

/**
 * Every engagement change goes through the state machine, writes the new
 * status with optimistic concurrency, appends an `engagement_transitions`
 * row (append-only), an audit entry and the `engagement.transitioned` outbox
 * event. The caller authorises the action and passes the billing consequence
 * in `metadata` where the machine's rule names one.
 */
export async function transitionEngagement(
  tx: Transaction,
  fa: FinanceActor,
  input: EngagementTransitionInput,
): Promise<ServiceRequestRow> {
  const { sr } = input;
  const actorKind = input.actorKind ?? actorKindOf(fa);
  const decision = evaluateTransition(engagementMachine, {
    from: sr.status,
    to: input.to,
    actor: actorKind,
    reason: input.reason ?? null,
  });
  if (!decision.ok) {
    throw new ApiError('invalid_transition', decision.message, {
      details: { code: decision.code, from: sr.status, to: input.to },
    });
  }
  if (input.expectedVersion !== undefined && sr.version !== input.expectedVersion) {
    throw new ApiError('version_conflict', 'this request changed since you loaded it; reload and try again', {
      details: { currentVersion: sr.version },
    });
  }
  const patch: Partial<typeof schema.serviceRequests.$inferInsert> = {
    ...input.patch,
    status: input.to,
    version: sr.version + 1,
  };
  if (input.to === 'cancelled') patch.cancelReason = input.reason ?? null;
  if (input.to === 'rejected') patch.rejectReason = input.reason ?? null;
  if (input.to === 'paused') patch.pauseReason = input.reason ?? null;
  if (input.to === 'in_progress' && sr.status === 'paused') patch.pauseReason = null;
  if (input.to === 'completed') patch.completedAt = new Date();
  const updated = await tx
    .update(schema.serviceRequests)
    .set(patch)
    .where(and(eq(schema.serviceRequests.id, sr.id), eq(schema.serviceRequests.version, sr.version)))
    .returning();
  const next = updated[0];
  if (!next) {
    throw new ApiError('version_conflict', 'this request changed since you loaded it; reload and try again');
  }
  const metadata = {
    effect: decision.rule.effect ?? null,
    permission: decision.rule.permission ?? null,
    ...input.metadata,
  };
  await tx.insert(schema.engagementTransitions).values({
    serviceRequestId: sr.id,
    fromStatus: sr.status,
    toStatus: input.to,
    actorUserId: fa.actor.userId,
    actorType: actorKind,
    reason: input.reason ?? null,
    metadata,
  });
  await emitEvent(tx, fa, {
    eventType: 'engagement.transitioned',
    aggregateType: 'service_request',
    aggregateId: sr.id,
    organizationId: sr.organizationId,
    payload: {
      serviceRequestId: sr.id,
      reference: sr.reference,
      from: sr.status,
      to: input.to,
      reason: input.reason ?? null,
      requestedByUserId: sr.requestedByUserId,
      assignedPmUserId: next.assignedPmUserId,
      metadata,
    },
  });
  await recordAudit(tx, fa, {
    action: `service_request.${input.to}`,
    entityType: 'service_request',
    entityId: sr.id,
    organizationId: sr.organizationId,
    before: { status: sr.status, version: sr.version },
    after: { status: input.to, version: next.version, ...metadata },
    reason: input.reason ?? null,
  });
  return next;
}
