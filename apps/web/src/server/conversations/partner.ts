import 'server-only';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  ApiError,
  type ConversationDetail,
  type PartnerConversationCreate,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { resolveEntity, type EntityAccess } from '@/server/assignments/access';
import {
  actorContext,
  demote,
  elevate,
  isStaffIdentity,
  requireUserId,
  uniqueIds,
  type ServiceOptions,
} from '@/server/assignments/shared';
import { activeStaffAmong } from './access';
import { createConversation } from './service';

/**
 * A partner starts a conversation with the SimplexD team about one of their
 * assignments (project or service request), invited tenders, RFQs or
 * purchase orders. The partner never names participants: the server adds
 * the staff attached to the entity (the project manager, staff assigned as
 * coordinators or support, the person who issued the tender or order) and
 * falls back to the operations managers. Customers are never added; staff
 * may add them later through the ordinary participant endpoint.
 */

/** Staff assignment roles that make someone the partner's contact on an entity. */
const TEAM_ASSIGNMENT_ROLES = ['project_manager', 'coordinator', 'support'] as const;
const MAX_FALLBACK_STAFF = 10;

function featureFor(entityType: PartnerConversationCreate['entityType']): string | null {
  if (entityType === 'tender') return 'expansion.contractor_tendering';
  if (entityType === 'purchase_order' || entityType === 'rfq')
    return 'expansion.materials_procurement';
  return null;
}

/** Staff attached to the entity itself, read under the partner's own context (the rows are visible to them). */
async function entitySeeds(tx: Transaction, entity: EntityAccess): Promise<string[]> {
  const seeds: Array<string | null | undefined> = [];
  switch (entity.type) {
    case 'project': {
      // The assigned manager, not whoever created the record.
      const [p] = await tx
        .select({ pm: schema.projects.pmUserId })
        .from(schema.projects)
        .where(eq(schema.projects.id, entity.id));
      seeds.push(p?.pm);
      break;
    }
    case 'service_request': {
      const [sr] = await tx
        .select({ pm: schema.serviceRequests.assignedPmUserId })
        .from(schema.serviceRequests)
        .where(eq(schema.serviceRequests.id, entity.id));
      seeds.push(sr?.pm);
      break;
    }
    default:
      seeds.push(entity.createdBy);
  }
  if (entity.projectId && entity.type !== 'project') {
    const [p] = await tx
      .select({ pm: schema.projects.pmUserId })
      .from(schema.projects)
      .where(eq(schema.projects.id, entity.projectId));
    seeds.push(p?.pm);
  }
  return uniqueIds(seeds);
}

/**
 * Resolves the SimplexD side of the thread. Elevated for the staff lookups
 * (assignment rows of other people and staff roles are hidden from a
 * partner), after the partner's own relationship to the entity was proven.
 */
async function resolveTeam(
  tx: Transaction,
  ctx: ReturnType<typeof actorContext>,
  entity: EntityAccess,
  partnerUserId: string,
): Promise<string[]> {
  const seeds = await entitySeeds(tx, entity);
  await elevate(tx, ctx);
  try {
    const assigned =
      entity.projectId || entity.serviceRequestId
        ? await tx
            .select({ assigneeUserId: schema.assignments.assigneeUserId })
            .from(schema.assignments)
            .where(
              and(
                inArray(schema.assignments.status, ['accepted', 'active']),
                inArray(schema.assignments.role, [...TEAM_ASSIGNMENT_ROLES]),
                or(
                  entity.projectId ? eq(schema.assignments.projectId, entity.projectId) : undefined,
                  entity.serviceRequestId
                    ? eq(schema.assignments.serviceRequestId, entity.serviceRequestId)
                    : undefined,
                ),
              ),
            )
        : [];
    const candidates = uniqueIds([...seeds, ...assigned.map((a) => a.assigneeUserId)]).filter(
      (id) => id !== partnerUserId,
    );
    const staff = await activeStaffAmong(tx, candidates);
    let team = candidates.filter((id) => staff.has(id));
    if (team.length === 0) {
      const ops = await tx
        .select({ userId: schema.staffRoles.userId })
        .from(schema.staffRoles)
        .where(
          and(
            eq(schema.staffRoles.role, 'operations_manager'),
            isNull(schema.staffRoles.revokedAt),
          ),
        );
      team = uniqueIds(ops.map((r) => r.userId))
        .filter((id) => id !== partnerUserId)
        .slice(0, MAX_FALLBACK_STAFF);
    }
    return team;
  } finally {
    await demote(tx, ctx);
  }
}

export async function startPartnerConversation(
  identity: RequestIdentity,
  input: PartnerConversationCreate,
  options: ServiceOptions = {},
): Promise<ConversationDetail & { staffParticipantUserIds: string[] }> {
  const userId = requireUserId(identity);
  if (!identity.actor.isPartner || isStaffIdentity(identity)) {
    throw new ApiError('forbidden', 'only partner accounts start conversations this way');
  }
  const feature = featureFor(input.entityType);
  if (feature) requireFeature(identity, feature);
  const ctx = actorContext(identity, options);
  const team = await withActor(getDb(), ctx, async (tx) => {
    const entity = await resolveEntity(tx, input.entityType, input.entityId);
    if (!entity) throw new ApiError('not_found', `${input.entityType.replace('_', ' ')} not found`);
    if (!entity.assigneeUserIds.includes(userId)) {
      throw new ApiError(
        'forbidden',
        'you are not assigned to, invited to or named on this record',
      );
    }
    const resolved = await resolveTeam(tx, ctx, entity, userId);
    if (resolved.length === 0) {
      throw new ApiError(
        'conflict',
        'no SimplexD staff are available to receive this conversation yet; try again later',
        { details: { code: 'no_staff_available' } },
      );
    }
    return resolved;
  });
  const detail = await createConversation(
    identity,
    {
      kind: 'partner',
      subject: input.subject,
      entityType: input.entityType,
      entityId: input.entityId,
      participantUserIds: team,
      initialMessage: input.message,
    },
    options,
  );
  await withActor(getDb(), ctx, (tx) =>
    appendOutbox(tx, {
      eventType: 'conversation.partner_started',
      aggregateType: 'conversation',
      aggregateId: detail.id,
      organizationId: detail.organizationId,
      actorUserId: userId,
      payload: {
        conversationId: detail.id,
        entityType: input.entityType,
        entityId: input.entityId,
        partnerUserId: userId,
        recipientUserIds: team,
      },
      correlationId: options.correlationId ?? null,
    }),
  );
  return { ...detail, staffParticipantUserIds: team };
}
