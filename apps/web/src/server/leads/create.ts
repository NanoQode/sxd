import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiError, type ConsultationRequest } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type ActorContext } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';

export interface CreateLeadOptions {
  source: 'website_form' | 'consultation_booking' | 'map_scenario' | 'quote_request';
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string;
}

/**
 * Persists a lead from a public or portal form. Carries the selected
 * scenario, markets and budget so the customer never repeats them. Spam
 * heuristics (honeypot, too-fast submission) mark the lead instead of
 * rejecting, so operations can review.
 */
export async function createLead(
  input: ConsultationRequest,
  identity: RequestIdentity | null,
  options: CreateLeadOptions,
): Promise<{ id: string; status: string }> {
  const suspicious =
    Boolean(input.website) || (input.elapsedMs !== undefined && input.elapsedMs < 1500);
  // Anonymous visitors insert leads and consents under the plain anonymous
  // context: the row-level policies allow anonymous appends but never reads.
  const ctx: ActorContext = identity?.ctx ?? { userId: null, organizationId: null, staff: false };
  const db = getDb();
  return withActor(db, { ...ctx, correlationId: options.correlationId }, async (tx) => {
    let interestServiceId: string | null = null;
    if (input.serviceSlug) {
      const svc = await tx
        .select({ id: schema.services.id })
        .from(schema.services)
        .where(eq(schema.services.slug, input.serviceSlug));
      interestServiceId = svc[0]?.id ?? null;
    }
    let marketIds: string[] = [];
    if (input.marketIds.length > 0) {
      const found = await tx
        .select({ id: schema.markets.id, name: schema.markets.name })
        .from(schema.markets)
        .where(inArray(schema.markets.id, input.marketIds));
      marketIds = found.map((m) => m.id);
    }
    if (input.scenarioId) {
      const scenario = await tx
        .select({ id: schema.scenarios.id })
        .from(schema.scenarios)
        .where(and(eq(schema.scenarios.id, input.scenarioId)));
      if (scenario.length === 0)
        throw new ApiError('not_found', 'scenario not found or not accessible');
    }
    // Anonymous rows cannot be read back (RETURNING applies the read policy), so the
    // id and status are decided here and inserted without RETURNING.
    const leadId = randomUUID();
    const status = suspicious ? ('spam' as const) : ('new' as const);
    await tx.insert(schema.leads).values({
      id: leadId,
      userId: identity?.session?.user.id ?? null,
      organizationId: identity?.ctx.organizationId ?? null,
      contactName: input.contactName,
      email: input.email.toLowerCase(),
      phoneE164: input.phoneE164 ?? null,
      countryOfResidence: input.countryOfResidence ?? null,
      timeZone: input.timeZone ?? null,
      source: options.source,
      interestServiceId,
      goal: input.goal,
      message: input.message ?? null,
      scenarioId: input.scenarioId ?? null,
      context: {
        marketIds,
        budgetNaira: input.budgetNaira ?? null,
        elapsedMs: input.elapsedMs ?? null,
        suspicious,
      },
      status,
      marketingConsent: input.marketingConsent,
      consentPolicyVersion: input.consentPolicyVersion,
      ipHash: options.ipHash,
      userAgent: options.userAgent?.slice(0, 300) ?? null,
    });
    if (input.marketingConsent) {
      await tx.insert(schema.consents).values({
        userId: identity?.session?.user.id ?? null,
        subjectEmail: input.email.toLowerCase(),
        purpose: 'marketing_email',
        granted: true,
        policyVersion: input.consentPolicyVersion,
        source: options.source,
        ipHash: options.ipHash,
      });
    }
    await appendOutbox(tx, {
      eventType: 'lead.created',
      aggregateType: 'lead',
      aggregateId: leadId,
      organizationId: identity?.ctx.organizationId ?? null,
      actorUserId: identity?.session?.user.id ?? null,
      payload: { leadId: leadId, source: options.source, suspicious },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'lead.created',
      entityType: 'lead',
      entityId: leadId,
      after: { source: options.source, suspicious },
      correlationId: options.correlationId,
    });
    return { id: leadId, status: status };
  });
}
