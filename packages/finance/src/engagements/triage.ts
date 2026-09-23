import { and, desc, eq, isNull, or } from 'drizzle-orm';
import {
  ApiError,
  type AssignRequest,
  type EngagementTransitionResult,
  type StaffTransition,
  type TriageRequest,
} from '@simplexd/contracts';
import { schema, withActor, type Transaction } from '@simplexd/db';
import type { EngagementState } from '@simplexd/domain/workflow';
import { assertStaff, type FinanceActor } from '../actor';
import { recordAudit } from '../audit';
import type { FinanceRuntime } from '../runtime';
import { voidUnpaidInvoicesForRequest } from '../invoices';
import {
  loadServiceRequestForUpdate,
  toTransitionResult,
  transitionEngagement,
  type ServiceRequestRow,
} from './transitions';

/**
 * SLA due time from `sla_policies`: the most specific active policy for the
 * service and stage wins (service-specific over global). Business-hours
 * policies are approximated with calendar hours here; the escalation job
 * applies the business calendar when it evaluates breaches.
 */
export async function computeSlaDueAt(
  tx: Transaction,
  serviceId: string,
  stage: EngagementState,
  now: Date,
): Promise<{ dueAt: Date | null; policyId: string | null; targetHours: number | null }> {
  const [policy] = await tx
    .select()
    .from(schema.slaPolicies)
    .where(
      and(
        eq(schema.slaPolicies.stage, stage),
        eq(schema.slaPolicies.active, true),
        or(eq(schema.slaPolicies.serviceId, serviceId), isNull(schema.slaPolicies.serviceId)),
      ),
    )
    .orderBy(desc(schema.slaPolicies.serviceId))
    .limit(1);
  if (!policy) return { dueAt: null, policyId: null, targetHours: null };
  return {
    dueAt: new Date(now.getTime() + policy.targetHours * 3_600_000),
    policyId: policy.id,
    targetHours: policy.targetHours,
  };
}

function staffResource(sr: ServiceRequestRow, extraAssignee?: string) {
  const assignees = [sr.assignedPmUserId, extraAssignee].filter((v): v is string => Boolean(v));
  return {
    type: 'service_request',
    id: sr.id,
    organizationId: sr.organizationId,
    assigneeUserIds: assignees,
  };
}

async function assertUserExists(tx: Transaction, userId: string): Promise<void> {
  const [row] = await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId));
  if (!row) throw new ApiError('validation_failed', 'assigned project manager does not exist');
}

/** inquiry → triage with assignment, priority and SLA (staff `service_requests.triage`). */
export async function triageServiceRequest(
  rt: FinanceRuntime,
  fa: FinanceActor,
  serviceRequestId: string,
  input: TriageRequest,
): Promise<EngagementTransitionResult> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const sr = await loadServiceRequestForUpdate(tx, serviceRequestId);
    assertStaff(fa, 'service_requests.triage', staffResource(sr, input.assignedPmUserId));
    await assertUserExists(tx, input.assignedPmUserId);
    const now = rt.now();
    const sla = input.slaDueAt
      ? { dueAt: new Date(input.slaDueAt), policyId: null, targetHours: null }
      : await computeSlaDueAt(tx, sr.serviceId, 'triage', now);
    const next = await transitionEngagement(tx, fa, {
      sr,
      to: 'triage',
      expectedVersion: input.expectedVersion,
      patch: {
        assignedPmUserId: input.assignedPmUserId,
        priority: input.priority,
        slaDueAt: sla.dueAt,
      },
      metadata: {
        assignedPmUserId: input.assignedPmUserId,
        priority: input.priority,
        slaDueAt: sla.dueAt?.toISOString() ?? null,
        slaPolicyId: sla.policyId,
        slaTargetHours: sla.targetHours,
        note: input.note ?? null,
      },
    });
    if (input.note) {
      await tx.insert(schema.notes).values({
        organizationId: sr.organizationId,
        entityType: 'service_request',
        entityId: sr.id,
        body: input.note,
        visibility: 'internal',
        authorUserId: fa.actor.userId!,
      });
    }
    return toTransitionResult(next);
  });
}

/**
 * Assigns (or reassigns) the project manager. When the engagement is
 * `accepted` and `startWork` is set, work starts without upfront payment
 * (policy decision recorded in the transition).
 */
export async function assignServiceRequest(
  rt: FinanceRuntime,
  fa: FinanceActor,
  serviceRequestId: string,
  input: AssignRequest,
): Promise<EngagementTransitionResult> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const sr = await loadServiceRequestForUpdate(tx, serviceRequestId);
    assertStaff(fa, 'service_requests.assign', staffResource(sr, input.assignedPmUserId));
    await assertUserExists(tx, input.assignedPmUserId);
    if (input.startWork && sr.status === 'accepted') {
      const next = await transitionEngagement(tx, fa, {
        sr,
        to: 'in_progress',
        reason: input.reason ?? null,
        expectedVersion: input.expectedVersion,
        patch: { assignedPmUserId: input.assignedPmUserId },
        metadata: { assignedPmUserId: input.assignedPmUserId, billingConsequence: 'no_upfront_payment' },
      });
      return toTransitionResult(next);
    }
    if (sr.version !== input.expectedVersion) {
      throw new ApiError('version_conflict', 'this request changed since you loaded it; reload and try again', {
        details: { currentVersion: sr.version },
      });
    }
    const [next] = await tx
      .update(schema.serviceRequests)
      .set({ assignedPmUserId: input.assignedPmUserId, version: sr.version + 1 })
      .where(and(eq(schema.serviceRequests.id, sr.id), eq(schema.serviceRequests.version, sr.version)))
      .returning();
    if (!next) throw new ApiError('version_conflict', 'this request changed since you loaded it');
    await recordAudit(tx, fa, {
      action: 'service_request.assigned',
      entityType: 'service_request',
      entityId: sr.id,
      organizationId: sr.organizationId,
      before: { assignedPmUserId: sr.assignedPmUserId },
      after: { assignedPmUserId: input.assignedPmUserId },
      reason: input.reason ?? null,
    });
    return toTransitionResult(next);
  });
}

const STAFF_PERMISSION_FOR: Partial<Record<EngagementState, 'service_requests.triage' | 'service_requests.override' | 'service_requests.assign'>> = {
  rejected: 'service_requests.triage',
  in_progress: 'service_requests.override',
  cancelled: 'service_requests.override',
  paused: 'service_requests.assign',
  in_review: 'service_requests.assign',
  delivered: 'service_requests.override',
  completed: 'service_requests.override',
};

/**
 * Staff transitions: reject (no billing), pause/resume, cancel with the
 * billing consequence, override into in_progress. Cancelling an engagement
 * with unpaid invoices voids them (reversing journals) when the caller asks
 * for `void_unpaid_invoices`; anything paid is left for finance review.
 */
export async function applyStaffTransition(
  rt: FinanceRuntime,
  fa: FinanceActor,
  serviceRequestId: string,
  input: StaffTransition,
): Promise<EngagementTransitionResult> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const sr = await loadServiceRequestForUpdate(tx, serviceRequestId);
    const permission = STAFF_PERMISSION_FOR[input.to] ?? 'service_requests.override';
    assertStaff(fa, permission, staffResource(sr));
    const billingConsequence = input.billingConsequence ?? billingDefaultFor(sr.status, input.to);
    const next = await transitionEngagement(tx, fa, {
      sr,
      to: input.to,
      reason: input.reason ?? null,
      expectedVersion: input.expectedVersion,
      metadata: { billingConsequence },
    });
    if (input.to === 'cancelled' && billingConsequence === 'void_unpaid_invoices') {
      const voided = await voidUnpaidInvoicesForRequest(tx, fa, sr.id, `engagement cancelled: ${input.reason ?? 'no reason given'}`, rt.now());
      await recordAudit(tx, fa, {
        action: 'service_request.cancel_billing',
        entityType: 'service_request',
        entityId: sr.id,
        organizationId: sr.organizationId,
        after: { voidedInvoiceIds: voided },
        reason: input.reason ?? null,
      });
    }
    return toTransitionResult(next);
  });
}

function billingDefaultFor(from: EngagementState, to: EngagementState): StaffTransition['billingConsequence'] {
  if (to === 'rejected') return 'none';
  if (to === 'cancelled') {
    return ['inquiry', 'triage', 'quoted', 'accepted', 'awaiting_payment'].includes(from)
      ? 'void_unpaid_invoices'
      : 'invoice_pro_rata';
  }
  return 'none';
}
