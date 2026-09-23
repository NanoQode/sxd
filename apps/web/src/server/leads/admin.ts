import 'server-only';
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  type LeadConvert,
  type LeadConvertResult,
  type LeadDetailDto,
  type LeadDto,
  type NoteDto,
  type Page,
  type StaffAssigneeDto,
  leadListQuerySchema,
  leadUpdateSchema,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { decodeCursor, encodeCursor } from '@/server/portal/pagination';
import { createServiceRequestRecord } from '@/server/requests/create';
import { toNoteDto } from '@/server/requests/queries';

/**
 * CRM administration for staff holding leads.read / leads.manage. Every
 * mutation records an audit entry with before/after state. Conversion either
 * creates a service request for an existing customer organisation or queues an
 * invitation email through the outbox and marks the lead contacted.
 */

type LeadRow = typeof schema.leads.$inferSelect;

interface LeadContext {
  marketIds?: string[];
  budgetNaira?: number | null;
  suspicious?: boolean;
  kind?: string;
}

function toLeadDto(
  lead: LeadRow,
  serviceName: string | null,
  assigneeName: string | null,
): LeadDto {
  return {
    id: lead.id,
    contactName: lead.contactName,
    email: lead.email,
    phoneE164: lead.phoneE164,
    countryOfResidence: lead.countryOfResidence,
    timeZone: lead.timeZone,
    source: lead.source,
    goal: lead.goal,
    interestServiceId: lead.interestServiceId,
    interestServiceName: serviceName,
    message: lead.message,
    scenarioId: lead.scenarioId,
    context: lead.context,
    status: lead.status,
    assignedToUserId: lead.assignedToUserId,
    assignedToName: assigneeName,
    convertedServiceRequestId: lead.convertedServiceRequestId,
    marketingConsent: lead.marketingConsent,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

function baseSelect(tx: Transaction) {
  return tx
    .select({
      lead: schema.leads,
      serviceName: schema.services.name,
      assigneeName: schema.user.name,
    })
    .from(schema.leads)
    .leftJoin(schema.services, eq(schema.services.id, schema.leads.interestServiceId))
    .leftJoin(schema.user, eq(schema.user.id, schema.leads.assignedToUserId));
}

export async function listLeads(
  identity: RequestIdentity,
  query: z.infer<typeof leadListQuerySchema>,
): Promise<Page<LeadDto>> {
  const parsed = leadListQuerySchema.parse(query);
  const cursor = decodeCursor(parsed.cursor);
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    baseSelect(tx)
      .where(
        and(
          parsed.status ? eq(schema.leads.status, parsed.status) : undefined,
          parsed.assignedToUserId
            ? parsed.assignedToUserId === 'unassigned'
              ? isNull(schema.leads.assignedToUserId)
              : eq(schema.leads.assignedToUserId, parsed.assignedToUserId)
            : undefined,
          parsed.q
            ? or(
                ilike(schema.leads.contactName, `%${parsed.q}%`),
                ilike(schema.leads.email, `%${parsed.q}%`),
              )
            : undefined,
          cursor
            ? or(
                lt(schema.leads.createdAt, cursor.createdAt),
                and(eq(schema.leads.createdAt, cursor.createdAt), lt(schema.leads.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.leads.createdAt), desc(schema.leads.id))
      .limit(parsed.limit + 1),
  );
  const items = rows
    .slice(0, parsed.limit)
    .map((r) => toLeadDto(r.lead, r.serviceName, r.assigneeName));
  const last = rows.length > parsed.limit ? rows[parsed.limit - 1] : null;
  return { items, nextCursor: last ? encodeCursor(last.lead.createdAt, last.lead.id) : null };
}

export async function getLeadDetail(identity: RequestIdentity, id: string): Promise<LeadDetailDto> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await baseSelect(tx).where(eq(schema.leads.id, id));
    const row = rows[0];
    if (!row) throw new ApiError('not_found', 'lead not found');
    const lead = row.lead;
    const context = (lead.context as LeadContext | null) ?? {};
    const marketIds = Array.isArray(context.marketIds)
      ? context.marketIds.filter((m) => typeof m === 'string')
      : [];
    const markets =
      marketIds.length > 0
        ? await tx
            .select({
              id: schema.markets.id,
              name: schema.markets.name,
              stateName: schema.states.name,
            })
            .from(schema.markets)
            .innerJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
            .where(inArray(schema.markets.id, marketIds))
        : [];
    const [scenario] = lead.scenarioId
      ? await tx
          .select({
            id: schema.scenarios.id,
            name: schema.scenarios.name,
            objective: schema.scenarios.objective,
          })
          .from(schema.scenarios)
          .where(eq(schema.scenarios.id, lead.scenarioId))
      : [];
    const [linkedUser] = await tx
      .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(
        lead.userId
          ? eq(schema.user.id, lead.userId)
          : sql`lower(${schema.user.email}) = ${lead.email.toLowerCase()}`,
      )
      .limit(1);
    const [org] = lead.organizationId
      ? await tx
          .select({ name: schema.organization.name })
          .from(schema.organization)
          .where(eq(schema.organization.id, lead.organizationId))
      : [];
    const [service] = lead.interestServiceId
      ? await tx
          .select({ slug: schema.services.slug })
          .from(schema.services)
          .where(eq(schema.services.id, lead.interestServiceId))
      : [];
    const notes = await tx
      .select({ n: schema.notes, authorName: schema.user.name })
      .from(schema.notes)
      .leftJoin(schema.user, eq(schema.user.id, schema.notes.authorUserId))
      .where(and(eq(schema.notes.entityType, 'lead'), eq(schema.notes.entityId, id)))
      .orderBy(desc(schema.notes.createdAt));
    const [converted] = lead.convertedServiceRequestId
      ? await tx
          .select({ reference: schema.serviceRequests.reference })
          .from(schema.serviceRequests)
          .where(eq(schema.serviceRequests.id, lead.convertedServiceRequestId))
      : [];
    return {
      ...toLeadDto(lead, row.serviceName, row.assigneeName),
      interestServiceSlug: service?.slug ?? null,
      markets,
      budgetNaira: typeof context.budgetNaira === 'number' ? context.budgetNaira : null,
      scenario: scenario ?? null,
      linkedUser: linkedUser ?? null,
      organizationName: org?.name ?? null,
      notes: notes.map((n) => toNoteDto(n.n, n.authorName)),
      convertedReference: converted?.reference ?? null,
      suspicious: Boolean(context.suspicious),
    };
  });
}

export async function listStaffAssignees(identity: RequestIdentity): Promise<StaffAssigneeDto[]> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({
        userId: schema.staffRoles.userId,
        role: schema.staffRoles.role,
        name: schema.user.name,
        email: schema.user.email,
      })
      .from(schema.staffRoles)
      .innerJoin(schema.user, eq(schema.user.id, schema.staffRoles.userId))
      .where(isNull(schema.staffRoles.revokedAt))
      .orderBy(schema.user.name),
  );
  const byUser = new Map<string, StaffAssigneeDto>();
  for (const r of rows) {
    const existing = byUser.get(r.userId);
    if (existing) existing.roles.push(r.role);
    else byUser.set(r.userId, { userId: r.userId, name: r.name, email: r.email, roles: [r.role] });
  }
  return [...byUser.values()];
}

export async function updateLead(
  identity: RequestIdentity,
  id: string,
  input: z.infer<typeof leadUpdateSchema>,
  options: { correlationId: string },
): Promise<LeadDto> {
  const parsed = leadUpdateSchema.parse(input);
  const userId = identity.session!.user.id;
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await baseSelect(tx).where(eq(schema.leads.id, id));
    const row = rows[0];
    if (!row) throw new ApiError('not_found', 'lead not found');
    const lead = row.lead;
    if (parsed.assignedToUserId) {
      const staff = await tx
        .select({ id: schema.staffRoles.id })
        .from(schema.staffRoles)
        .where(
          and(
            eq(schema.staffRoles.userId, parsed.assignedToUserId),
            isNull(schema.staffRoles.revokedAt),
          ),
        );
      if (staff.length === 0)
        throw new ApiError('validation_failed', 'assignee must be an active staff member');
    }
    if (parsed.status === 'converted' && !lead.convertedServiceRequestId) {
      throw new ApiError('invalid_transition', 'use the convert action to mark a lead converted');
    }
    const patch: Partial<typeof schema.leads.$inferInsert> = {};
    if (parsed.status !== undefined) patch.status = parsed.status;
    if (parsed.assignedToUserId !== undefined) patch.assignedToUserId = parsed.assignedToUserId;
    if (Object.keys(patch).length > 0) {
      await tx.update(schema.leads).set(patch).where(eq(schema.leads.id, id));
    }
    if (parsed.note && parsed.note.trim().length > 0) {
      await tx.insert(schema.notes).values({
        organizationId: null,
        entityType: 'lead',
        entityId: id,
        body: parsed.note.trim(),
        visibility: 'internal',
        authorUserId: userId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'lead.updated',
      entityType: 'lead',
      entityId: id,
      organizationId: lead.organizationId,
      before: { status: lead.status, assignedToUserId: lead.assignedToUserId },
      after: {
        status: patch.status ?? lead.status,
        assignedToUserId:
          patch.assignedToUserId === undefined ? lead.assignedToUserId : patch.assignedToUserId,
      },
      reason: parsed.note ?? null,
      correlationId: options.correlationId,
    });
    const after = await baseSelect(tx).where(eq(schema.leads.id, id));
    return toLeadDto(after[0]!.lead, after[0]!.serviceName, after[0]!.assigneeName);
  });
}

export async function addLeadNote(
  identity: RequestIdentity,
  id: string,
  body: string,
  options: { correlationId: string },
): Promise<NoteDto> {
  const userId = identity.session!.user.id;
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [lead] = await tx
      .select({ id: schema.leads.id, organizationId: schema.leads.organizationId })
      .from(schema.leads)
      .where(eq(schema.leads.id, id));
    if (!lead) throw new ApiError('not_found', 'lead not found');
    const [note] = await tx
      .insert(schema.notes)
      .values({
        organizationId: null,
        entityType: 'lead',
        entityId: id,
        body,
        visibility: 'internal',
        authorUserId: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'lead.note_added',
      entityType: 'lead',
      entityId: id,
      organizationId: lead.organizationId,
      after: { noteId: note!.id },
      correlationId: options.correlationId,
    });
    return toNoteDto(note!, identity.session!.user.name);
  });
}

/**
 * Convert a lead. Path A: the lead's email belongs to a user who is a member of
 * a customer organisation → a service request is created in `inquiry` for the
 * chosen service and linked. Path B: no such account → an invitation email is
 * queued through the outbox (`lead.invited`) and the lead is marked contacted.
 */
export async function convertLead(
  identity: RequestIdentity,
  id: string,
  input: LeadConvert,
  options: { correlationId: string },
): Promise<LeadConvertResult> {
  const staffUserId = identity.session!.user.id;
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [lead] = await tx.select().from(schema.leads).where(eq(schema.leads.id, id));
    if (!lead) throw new ApiError('not_found', 'lead not found');
    if (lead.status === 'converted')
      throw new ApiError('invalid_transition', 'this lead was already converted');
    if (lead.status === 'spam')
      throw new ApiError(
        'invalid_transition',
        'mark the lead as new or qualified before converting',
      );
    const serviceRows = input.serviceSlug
      ? await tx.select().from(schema.services).where(eq(schema.services.slug, input.serviceSlug))
      : lead.interestServiceId
        ? await tx
            .select()
            .from(schema.services)
            .where(eq(schema.services.id, lead.interestServiceId))
        : [];
    const service = serviceRows[0];
    if (!service)
      throw new ApiError(
        'validation_failed',
        'choose a service to convert this lead into a request',
      );

    const [user] = await tx
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(
        lead.userId
          ? eq(schema.user.id, lead.userId)
          : sql`lower(${schema.user.email}) = ${lead.email.toLowerCase()}`,
      )
      .limit(1);
    const memberships = user
      ? await tx
          .select({ organizationId: schema.member.organizationId })
          .from(schema.member)
          .where(eq(schema.member.userId, user.id))
          .orderBy(schema.member.createdAt)
      : [];
    const organizationId =
      memberships.find((m) => m.organizationId === lead.organizationId)?.organizationId ??
      memberships[0]?.organizationId ??
      null;
    const context = (lead.context as LeadContext | null) ?? {};

    if (user && organizationId) {
      const created = await createServiceRequestRecord(tx, identity, {
        organizationId,
        requestedByUserId: user.id,
        serviceId: service.id,
        title: input.title?.trim() || `${service.name} for ${lead.contactName}`,
        description: lead.message,
        marketId:
          Array.isArray(context.marketIds) && typeof context.marketIds[0] === 'string'
            ? context.marketIds[0]
            : null,
        scenarioId: lead.scenarioId,
        leadId: lead.id,
        context: {
          source: 'lead_conversion',
          leadId: lead.id,
          goal: lead.goal,
          budgetNaira: typeof context.budgetNaira === 'number' ? context.budgetNaira : null,
          intake: {},
        },
        actorType: 'staff',
        actorUserId: staffUserId,
        correlationId: options.correlationId,
      });
      await tx
        .update(schema.leads)
        .set({
          status: 'converted',
          convertedServiceRequestId: created.id,
          userId: lead.userId ?? user.id,
          organizationId,
        })
        .where(eq(schema.leads.id, id));
      if (input.note) {
        await tx
          .insert(schema.notes)
          .values({
            organizationId: null,
            entityType: 'lead',
            entityId: id,
            body: input.note,
            visibility: 'internal',
            authorUserId: staffUserId,
          });
      }
      await recordAudit(tx, identity, {
        action: 'lead.converted',
        entityType: 'lead',
        entityId: id,
        organizationId,
        before: { status: lead.status },
        after: { status: 'converted', serviceRequestId: created.id, reference: created.reference },
        reason: input.note ?? null,
        correlationId: options.correlationId,
      });
      return {
        path: 'service_request_created',
        serviceRequestId: created.id,
        reference: created.reference,
        organizationId,
        leadStatus: 'converted',
      };
    }

    const nextPath = `/portal/requests/new?service=${encodeURIComponent(service.slug)}`;
    const inviteUrl = `${env().APP_URL}/sign-up?next=${encodeURIComponent(nextPath)}`;
    await appendOutbox(tx, {
      eventType: 'lead.invited',
      aggregateType: 'lead',
      aggregateId: lead.id,
      organizationId: null,
      actorUserId: staffUserId,
      payload: {
        leadId: lead.id,
        email: lead.email,
        contactName: lead.contactName,
        serviceSlug: service.slug,
        serviceName: service.name,
        inviteUrl,
        invitedBy: identity.session!.user.name,
        note: input.note ?? null,
        channel: 'email',
        category: 'transactional',
      },
      correlationId: options.correlationId,
    });
    await tx.update(schema.leads).set({ status: 'contacted' }).where(eq(schema.leads.id, id));
    if (input.note) {
      await tx
        .insert(schema.notes)
        .values({
          organizationId: null,
          entityType: 'lead',
          entityId: id,
          body: input.note,
          visibility: 'internal',
          authorUserId: staffUserId,
        });
    }
    await recordAudit(tx, identity, {
      action: 'lead.invited',
      entityType: 'lead',
      entityId: id,
      before: { status: lead.status },
      after: { status: 'contacted', serviceSlug: service.slug },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    return {
      path: 'invitation_sent',
      serviceRequestId: null,
      reference: null,
      organizationId: null,
      leadStatus: 'contacted',
    };
  });
}
