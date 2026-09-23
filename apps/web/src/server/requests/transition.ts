import 'server-only';
import { and, eq } from 'drizzle-orm';
import { ApiError, type ServiceRequestDto, type ServiceRequestTransition } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor } from '@simplexd/db';
import { engagementMachine, evaluateTransition } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { assertOrgPermission } from '@/server/portal/access';
import { loadServiceRequest, toServiceRequestDto } from './queries';

/**
 * Customer-initiated transitions (cancel, pause, resume). The engagement state
 * machine decides validity and whether a reason is required; the organisation
 * permission model decides who may ask; optimistic concurrency prevents a stale
 * screen from overriding a newer change. Staff transitions arrive in Wave 2.
 */
export async function applyCustomerTransition(
  identity: RequestIdentity,
  id: string,
  input: ServiceRequestTransition,
  options: { correlationId: string },
): Promise<ServiceRequestDto> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const userId = identity.session.user.id;
  const ctx = { ...identity.ctx, correlationId: options.correlationId };
  return withActor(getDb(), ctx, async (tx) => {
    const row = await loadServiceRequest(tx, id);
    if (!row) throw new ApiError('not_found', 'request not found');
    const sr = row.sr;
    const permission = input.to === 'cancelled' ? 'org.requests.cancel' : 'org.requests.create';
    assertOrgPermission(identity, permission, {
      type: 'service_request',
      id: sr.id,
      organizationId: sr.organizationId,
    });
    const decision = evaluateTransition(engagementMachine, {
      from: sr.status,
      to: input.to,
      actor: 'customer',
      reason: input.reason ?? null,
    });
    if (!decision.ok) {
      throw new ApiError('invalid_transition', decision.message, {
        details: { code: decision.code, from: sr.status, to: input.to },
      });
    }
    if (sr.version !== input.expectedVersion) {
      throw new ApiError('version_conflict', 'this request changed since you loaded it; reload and try again', {
        details: { currentVersion: sr.version },
      });
    }
    // The update, transition and log appends all run under the customer's own
    // context: the row is visible through the request policy.
    const patch: Partial<typeof schema.serviceRequests.$inferInsert> = {
      status: input.to,
      version: sr.version + 1,
    };
    if (input.to === 'cancelled') patch.cancelReason = input.reason ?? null;
    if (input.to === 'paused') patch.pauseReason = input.reason ?? null;
    if (input.to === 'in_progress') patch.pauseReason = null;
    const updated = await tx
      .update(schema.serviceRequests)
      .set(patch)
      .where(and(eq(schema.serviceRequests.id, sr.id), eq(schema.serviceRequests.version, sr.version)))
      .returning({ id: schema.serviceRequests.id });
    if (updated.length === 0) {
      throw new ApiError('version_conflict', 'this request changed since you loaded it; reload and try again');
    }
    await tx.insert(schema.engagementTransitions).values({
      serviceRequestId: sr.id,
      fromStatus: sr.status,
      toStatus: input.to,
      actorUserId: userId,
      actorType: 'customer',
      reason: input.reason ?? null,
      metadata: { effect: decision.rule.effect ?? null },
    });
    await appendOutbox(tx, {
      eventType: 'service_request.transitioned',
      aggregateType: 'service_request',
      aggregateId: sr.id,
      organizationId: sr.organizationId,
      actorUserId: userId,
      payload: { serviceRequestId: sr.id, reference: sr.reference, from: sr.status, to: input.to, reason: input.reason ?? null },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: `service_request.${input.to === 'in_progress' ? 'resumed' : input.to}`,
      entityType: 'service_request',
      entityId: sr.id,
      organizationId: sr.organizationId,
      before: { status: sr.status, version: sr.version },
      after: { status: input.to, version: sr.version + 1 },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    const after = await loadServiceRequest(tx, sr.id);
    return toServiceRequestDto(after!.sr, after!.service, after!.market, after!.pm);
  });
}
