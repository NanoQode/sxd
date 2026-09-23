import 'server-only';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { ApiError, type SlaPolicyCreate, type SlaPolicyPatch } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import {
  assertUpdatedAt,
  authorize,
  changedFields,
  notFound,
  transact,
  type AdminContext,
} from '../context';
import { authorizeAny, lockKey, serviceNames } from './shared';

/**
 * SLA policies: target hours per engagement stage, per service or for every
 * service. The most specific active policy wins (service over global). Triage
 * applies the `triage` target when it sets a request's SLA due time; the other
 * stage targets are recorded for queue reporting. At most one active policy
 * exists per service (or global) and stage. Reading needs `sla.manage` or
 * `service_requests.read_all`; writing needs `sla.manage`.
 */

type PolicyRow = typeof schema.slaPolicies.$inferSelect;

export interface SlaPolicyDto {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  stage: PolicyRow['stage'];
  targetHours: number;
  businessHoursOnly: boolean;
  escalateToRole: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

function toDto(r: PolicyRow, names: Map<string, string>): SlaPolicyDto {
  return {
    id: r.id,
    serviceId: r.serviceId,
    serviceName: r.serviceId ? (names.get(r.serviceId) ?? null) : null,
    stage: r.stage,
    targetHours: r.targetHours,
    businessHoursOnly: r.businessHoursOnly,
    escalateToRole: r.escalateToRole,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const lockFor = (serviceId: string | null, stage: string) =>
  `sla_policies:${serviceId ?? 'global'}:${stage}`;

async function assertNoOtherActive(
  tx: Transaction,
  serviceId: string | null,
  stage: PolicyRow['stage'],
  exceptId: string | null,
): Promise<void> {
  const rows = await tx
    .select({ id: schema.slaPolicies.id })
    .from(schema.slaPolicies)
    .where(
      and(
        serviceId
          ? eq(schema.slaPolicies.serviceId, serviceId)
          : isNull(schema.slaPolicies.serviceId),
        eq(schema.slaPolicies.stage, stage),
        eq(schema.slaPolicies.active, true),
        exceptId ? ne(schema.slaPolicies.id, exceptId) : undefined,
      ),
    );
  if (rows.length > 0)
    throw new ApiError(
      'conflict',
      `an active ${serviceId ? 'service' : 'global'} policy already exists for the ${stage} stage; edit or deactivate it first`,
    );
}

export async function listSlaPolicies(ctx: AdminContext): Promise<SlaPolicyDto[]> {
  authorizeAny(ctx, ['sla.manage', 'service_requests.read_all']);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.slaPolicies)
      .orderBy(
        asc(schema.slaPolicies.serviceId),
        asc(schema.slaPolicies.stage),
        asc(schema.slaPolicies.createdAt),
      );
    const names = await serviceNames(
      tx,
      rows.map((r) => r.serviceId),
    );
    return rows.map((r) => toDto(r, names));
  });
}

export async function createSlaPolicy(
  ctx: AdminContext,
  input: SlaPolicyCreate,
): Promise<SlaPolicyDto> {
  authorize(ctx, 'sla.manage');
  return transact(ctx, async (tx) => {
    if (input.serviceId) {
      const [svc] = await tx
        .select({ id: schema.services.id })
        .from(schema.services)
        .where(eq(schema.services.id, input.serviceId));
      if (!svc) throw notFound('service');
    }
    await lockKey(tx, lockFor(input.serviceId, input.stage));
    if (input.active ?? true) await assertNoOtherActive(tx, input.serviceId, input.stage, null);
    const [row] = await tx
      .insert(schema.slaPolicies)
      .values({
        serviceId: input.serviceId,
        stage: input.stage,
        targetHours: input.targetHours,
        businessHoursOnly: input.businessHoursOnly ?? true,
        escalateToRole: input.escalateToRole ?? null,
        active: input.active ?? true,
      })
      .returning();
    const dto = toDto(row!, await serviceNames(tx, [row!.serviceId]));
    await recordAudit(tx, ctx.identity, {
      action: 'sla_policy.created',
      entityType: 'sla_policy',
      entityId: row!.id,
      after: dto,
      correlationId: ctx.correlationId,
    });
    return dto;
  });
}

export async function patchSlaPolicy(
  ctx: AdminContext,
  id: string,
  input: SlaPolicyPatch,
): Promise<SlaPolicyDto> {
  authorize(ctx, 'sla.manage');
  return transact(ctx, async (tx) => {
    const [peek] = await tx
      .select({ serviceId: schema.slaPolicies.serviceId, stage: schema.slaPolicies.stage })
      .from(schema.slaPolicies)
      .where(eq(schema.slaPolicies.id, id));
    if (!peek) throw notFound('SLA policy');
    await lockKey(tx, lockFor(peek.serviceId, peek.stage));
    const [current] = await tx
      .select()
      .from(schema.slaPolicies)
      .where(eq(schema.slaPolicies.id, id))
      .for('update');
    if (!current) throw notFound('SLA policy');
    assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    if (input.active === true && !current.active)
      await assertNoOtherActive(tx, current.serviceId, current.stage, id);
    const [updated] = await tx
      .update(schema.slaPolicies)
      .set({
        ...(input.targetHours !== undefined ? { targetHours: input.targetHours } : {}),
        ...(input.businessHoursOnly !== undefined
          ? { businessHoursOnly: input.businessHoursOnly }
          : {}),
        ...(input.escalateToRole !== undefined ? { escalateToRole: input.escalateToRole } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(schema.slaPolicies.id, id))
      .returning();
    const names = await serviceNames(tx, [current.serviceId]);
    const diff = changedFields(
      toDto(current, names) as unknown as Record<string, unknown>,
      toDto(updated!, names) as unknown as Record<string, unknown>,
    );
    delete diff.before.updatedAt;
    delete diff.after.updatedAt;
    await recordAudit(tx, ctx.identity, {
      action: 'sla_policy.updated',
      entityType: 'sla_policy',
      entityId: id,
      before: diff.before,
      after: diff.after,
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!, names);
  });
}
