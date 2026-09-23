import 'server-only';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type EngagementTransitionDto,
  type NoteDto,
  type Page,
  type ServiceRequestDetail,
  type ServiceRequestDto,
  type ServiceRequestListQuery,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { availableTransitions, engagementMachine } from '@simplexd/domain/workflow';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, encodeCursor, keysetAfter } from '@/server/portal/pagination';

type SrRow = typeof schema.serviceRequests.$inferSelect;

interface SrContext {
  intake?: Record<string, string>;
  budgetNaira?: number | null;
  preferredTimeline?: ServiceRequestDto['preferredTimeline'];
}

export function toServiceRequestDto(
  sr: SrRow,
  service: { slug: string; name: string },
  market: { name: string | null } | null,
  pm: { id: string | null; name: string | null } | null,
): ServiceRequestDto {
  const ctx = (sr.context as SrContext | null) ?? {};
  return {
    id: sr.id,
    reference: sr.reference,
    title: sr.title,
    description: sr.description,
    status: sr.status,
    serviceId: sr.serviceId,
    serviceSlug: service.slug,
    serviceName: service.name,
    marketId: sr.marketId,
    marketName: market?.name ?? null,
    scenarioId: sr.scenarioId,
    budgetNaira: typeof ctx.budgetNaira === 'number' ? ctx.budgetNaira : null,
    preferredTimeline: ctx.preferredTimeline ?? null,
    intake: ctx.intake ?? {},
    assignedPm: pm && pm.id && pm.name ? { id: pm.id, name: pm.name } : null,
    priority: sr.priority,
    pauseReason: sr.pauseReason,
    cancelReason: sr.cancelReason,
    rejectReason: sr.rejectReason,
    completedAt: sr.completedAt?.toISOString() ?? null,
    version: sr.version,
    createdAt: sr.createdAt.toISOString(),
    updatedAt: sr.updatedAt.toISOString(),
  };
}

function baseSelect(tx: Transaction) {
  return tx
    .select({
      sr: schema.serviceRequests,
      service: { slug: schema.services.slug, name: schema.services.name },
      market: { name: schema.markets.name },
      pm: { id: schema.user.id, name: schema.user.name },
    })
    .from(schema.serviceRequests)
    .innerJoin(schema.services, eq(schema.services.id, schema.serviceRequests.serviceId))
    .leftJoin(schema.markets, eq(schema.markets.id, schema.serviceRequests.marketId))
    .leftJoin(schema.user, eq(schema.user.id, schema.serviceRequests.assignedPmUserId));
}

/** Requests visible to the caller (row-level security) within the active organisation. */
export async function listServiceRequests(
  identity: RequestIdentity,
  query: ServiceRequestListQuery,
): Promise<Page<ServiceRequestDto>> {
  const orgId = identity.ctx.organizationId;
  if (!orgId) return { items: [], nextCursor: null };
  const cursor = decodeCursor(query.cursor);
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    baseSelect(tx)
      .where(
        and(
          eq(schema.serviceRequests.organizationId, orgId),
          query.status ? eq(schema.serviceRequests.status, query.status) : undefined,
          cursor
            ? keysetAfter(schema.serviceRequests.createdAt, schema.serviceRequests.id, cursor)
            : undefined,
        ),
      )
      .orderBy(desc(schema.serviceRequests.createdAt), desc(schema.serviceRequests.id))
      .limit(query.limit + 1),
  );
  const items = rows
    .slice(0, query.limit)
    .map((r) => toServiceRequestDto(r.sr, r.service, r.market, r.pm));
  const last = rows.length > query.limit ? rows[query.limit - 1] : null;
  return {
    items,
    nextCursor: last ? encodeCursor(last.sr.createdAt, last.sr.id) : null,
  };
}

export async function loadServiceRequest(
  tx: Transaction,
  id: string,
): Promise<{
  sr: SrRow;
  service: { slug: string; name: string };
  market: { name: string | null } | null;
  pm: { id: string | null; name: string | null } | null;
} | null> {
  const rows = await baseSelect(tx).where(inArray(schema.serviceRequests.id, [id]));
  return rows[0] ?? null;
}

/** Detail with status timeline, customer-visible notes and the transitions the customer may request. */
export async function getServiceRequestDetail(
  identity: RequestIdentity,
  id: string,
): Promise<ServiceRequestDetail> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await loadServiceRequest(tx, id);
    if (!row) throw new ApiError('not_found', 'request not found');
    const transitions = await tx
      .select({ t: schema.engagementTransitions, actorName: schema.user.name })
      .from(schema.engagementTransitions)
      .leftJoin(schema.user, eq(schema.user.id, schema.engagementTransitions.actorUserId))
      .where(eq(schema.engagementTransitions.serviceRequestId, id))
      .orderBy(asc(schema.engagementTransitions.createdAt), asc(schema.engagementTransitions.id));
    const isStaff = identity.actor.staffRoles.length > 0;
    const notes = await tx
      .select({ n: schema.notes, authorName: schema.user.name })
      .from(schema.notes)
      .leftJoin(schema.user, eq(schema.user.id, schema.notes.authorUserId))
      .where(
        and(
          eq(schema.notes.entityType, 'service_request'),
          eq(schema.notes.entityId, id),
          // Customers only ever see customer-facing notes; row-level security enforces the same rule.
          isStaff ? undefined : inArray(schema.notes.visibility, ['customer', 'all']),
        ),
      )
      .orderBy(asc(schema.notes.createdAt));
    const dto = toServiceRequestDto(row.sr, row.service, row.market, row.pm);
    const available = availableTransitions(engagementMachine, row.sr.status, 'customer')
      .filter((rule) => ['cancelled', 'paused', 'in_progress'].includes(rule.to))
      .map((rule) => ({
        to: rule.to,
        reasonRequired: Boolean(rule.reasonRequired),
        effect: rule.effect ?? null,
      }));
    return {
      ...dto,
      transitions: transitions.map((r) => toTransitionDto(r.t, r.actorName)),
      notes: notes.map((r) => toNoteDto(r.n, r.authorName)),
      availableTransitions: available,
    };
  });
}

export function toTransitionDto(
  t: typeof schema.engagementTransitions.$inferSelect,
  actorName: string | null,
): EngagementTransitionDto {
  return {
    id: t.id,
    fromStatus: t.fromStatus,
    toStatus: t.toStatus,
    actorType: t.actorType,
    actorName,
    reason: t.reason,
    createdAt: t.createdAt.toISOString(),
  };
}

export function toNoteDto(n: typeof schema.notes.$inferSelect, authorName: string | null): NoteDto {
  return {
    id: n.id,
    body: n.body,
    visibility: n.visibility,
    authorName,
    authorUserId: n.authorUserId,
    createdAt: n.createdAt.toISOString(),
  };
}
