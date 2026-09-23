import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiError, type ServiceRequestCreate, type ServiceRequestDto } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { elevate } from '@/server/portal/elevate';
import { assertOrgPermission, requireActiveOrganization } from '@/server/portal/access';
import { insertWithReferenceRetry } from './reference';
import { toServiceRequestDto } from './queries';
import { intakeKeysFor, isBookable } from './services';

export interface CreateRequestOptions {
  correlationId: string;
}

export interface ServiceRequestRecordInput {
  organizationId: string;
  requestedByUserId: string;
  serviceId: string;
  title: string;
  description: string | null;
  marketId: string | null;
  scenarioId: string | null;
  leadId: string | null;
  context: Record<string, unknown>;
  actorType: 'customer' | 'staff';
  actorUserId: string;
  correlationId: string;
}

/**
 * Inserts a service request in `inquiry`, its first engagement transition, the
 * outbox event and the audit entry. The caller's transaction must already be
 * elevated (see server/portal/elevate.ts) and the caller must have authorised
 * the action. Shared by the customer intake flow and staff lead conversion.
 */
export async function createServiceRequestRecord(
  tx: Transaction,
  identity: RequestIdentity,
  input: ServiceRequestRecordInput,
): Promise<{ id: string; reference: string }> {
  const created = await insertWithReferenceRetry(tx, 'SR', async (reference) => {
    const [row] = await tx
      .insert(schema.serviceRequests)
      .values({
        reference,
        organizationId: input.organizationId,
        requestedByUserId: input.requestedByUserId,
        serviceId: input.serviceId,
        title: input.title,
        description: input.description,
        status: 'inquiry',
        marketId: input.marketId,
        scenarioId: input.scenarioId,
        leadId: input.leadId,
        context: input.context,
      })
      .returning({ id: schema.serviceRequests.id, reference: schema.serviceRequests.reference });
    return row!;
  });
  await tx.insert(schema.engagementTransitions).values({
    serviceRequestId: created.id,
    fromStatus: null,
    toStatus: 'inquiry',
    actorUserId: input.actorUserId,
    actorType: input.actorType,
    reason: null,
    metadata: { source: input.actorType === 'staff' ? 'lead_conversion' : 'portal' },
  });
  if (input.scenarioId) {
    await tx
      .update(schema.scenarios)
      .set({ convertedServiceRequestId: created.id })
      .where(eq(schema.scenarios.id, input.scenarioId));
  }
  await appendOutbox(tx, {
    eventType: 'service_request.transitioned',
    aggregateType: 'service_request',
    aggregateId: created.id,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    payload: {
      serviceRequestId: created.id,
      reference: created.reference,
      from: null,
      to: 'inquiry',
      requestedByUserId: input.requestedByUserId,
    },
    correlationId: input.correlationId,
  });
  await recordAudit(tx, identity, {
    action: 'service_request.created',
    entityType: 'service_request',
    entityId: created.id,
    organizationId: input.organizationId,
    after: {
      reference: created.reference,
      serviceId: input.serviceId,
      status: 'inquiry',
      leadId: input.leadId,
      scenarioId: input.scenarioId,
    },
    correlationId: input.correlationId,
  });
  return created;
}

/**
 * Customer intake: validates the chosen service is bookable, the market is
 * published and the scenario (if any) is accessible, then creates the request
 * with reference SR-<year>-<sequence>.
 */
export async function createServiceRequest(
  input: ServiceRequestCreate,
  identity: RequestIdentity,
  options: CreateRequestOptions,
): Promise<ServiceRequestDto> {
  const organizationId = requireActiveOrganization(identity);
  assertOrgPermission(identity, 'org.requests.create', { type: 'service_request', organizationId });
  const userId = identity.session!.user.id;
  const db = getDb();
  const ctx = { ...identity.ctx, correlationId: options.correlationId };

  return withActor(db, ctx, async (tx) => {
    const [service] = await tx
      .select()
      .from(schema.services)
      .where(eq(schema.services.slug, input.serviceSlug));
    if (!service) throw new ApiError('not_found', 'service not found');
    if (!isBookable(service, identity.featureFlags)) {
      throw new ApiError('feature_disabled', `${service.name} is not bookable yet; register interest instead`, {
        details: { code: 'not_bookable', inquiryEnabled: service.inquiryEnabled, serviceSlug: service.slug },
      });
    }
    let marketName: string | null = null;
    if (input.marketId) {
      const [market] = await tx
        .select({ id: schema.markets.id, name: schema.markets.name })
        .from(schema.markets)
        .where(and(eq(schema.markets.id, input.marketId), eq(schema.markets.publicationState, 'published')));
      if (!market) throw new ApiError('validation_failed', 'the selected market is not available');
      marketName = market.name;
    }
    if (input.scenarioId) {
      // Row-level security scopes scenarios to the owner, organisation or share token.
      const [scenario] = await tx
        .select({ id: schema.scenarios.id, converted: schema.scenarios.convertedServiceRequestId })
        .from(schema.scenarios)
        .where(eq(schema.scenarios.id, input.scenarioId));
      if (!scenario) throw new ApiError('not_found', 'scenario not found or not accessible');
    }
    const allowedKeys = new Set(intakeKeysFor(service.workflowTemplateKey));
    const intake: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.intake)) {
      if (allowedKeys.has(key) && value.trim().length > 0) intake[key] = value.trim();
    }
    const title = input.title?.trim() || `${service.name}${marketName ? ` – ${marketName}` : ''}`;

    await elevate(tx, ctx);
    const created = await createServiceRequestRecord(tx, identity, {
      organizationId,
      requestedByUserId: userId,
      serviceId: service.id,
      title,
      description: input.description,
      marketId: input.marketId ?? null,
      scenarioId: input.scenarioId ?? null,
      leadId: null,
      context: {
        source: 'portal',
        intake,
        budgetNaira: input.budgetNaira ?? null,
        preferredTimeline: input.preferredTimeline ?? null,
        attachments: { status: 'deferred_to_wave_2' },
      },
      actorType: 'customer',
      actorUserId: userId,
      correlationId: options.correlationId,
    });
    const rows = await tx
      .select({
        sr: schema.serviceRequests,
        service: { slug: schema.services.slug, name: schema.services.name },
        market: { name: schema.markets.name },
        pm: { id: schema.user.id, name: schema.user.name },
      })
      .from(schema.serviceRequests)
      .innerJoin(schema.services, eq(schema.services.id, schema.serviceRequests.serviceId))
      .leftJoin(schema.markets, eq(schema.markets.id, schema.serviceRequests.marketId))
      .leftJoin(schema.user, eq(schema.user.id, schema.serviceRequests.assignedPmUserId))
      .where(inArray(schema.serviceRequests.id, [created.id]));
    const row = rows[0]!;
    return toServiceRequestDto(row.sr, row.service, row.market, row.pm);
  });
}
