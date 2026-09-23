import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { ApiError, type UnitCreate, type UnitDto, type UnitUpdate } from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  requireUserId,
  type ServiceOptions,
} from '@/server/assignments/shared';
import { requireProperty } from './access';
import { toUnitDto } from './dto';

type UnitInsert = typeof schema.units.$inferInsert;
type UnitRow = typeof schema.units.$inferSelect;

/** Units within a property; labels are unique per property. */

async function loadUnit(tx: DbExecutor, propertyId: string, unitId: string): Promise<UnitRow | null> {
  const rows = await tx
    .select()
    .from(schema.units)
    .where(and(eq(schema.units.id, unitId), eq(schema.units.propertyId, propertyId)));
  return rows[0] ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23503' || e?.cause?.code === '23503';
}

export async function listUnits(identity: RequestIdentity, propertyId: string): Promise<UnitDto[]> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    await requireProperty(tx, identity, propertyId, 'read');
    const rows = await tx
      .select()
      .from(schema.units)
      .where(eq(schema.units.propertyId, propertyId))
      .orderBy(asc(schema.units.label), asc(schema.units.id));
    return rows.map(toUnitDto);
  });
}

export async function createUnit(
  identity: RequestIdentity,
  propertyId: string,
  input: UnitCreate,
  options: ServiceOptions = {},
): Promise<UnitDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    const [existing] = await tx
      .select({ id: schema.units.id })
      .from(schema.units)
      .where(and(eq(schema.units.propertyId, propertyId), eq(schema.units.label, input.label)));
    if (existing) throw new ApiError('conflict', `a unit labelled "${input.label}" already exists`);
    let row: UnitRow | undefined;
    try {
      [row] = await tx
        .insert(schema.units)
        .values({
          propertyId,
          label: input.label,
          unitType: input.unitType,
          bedrooms: input.bedrooms ?? null,
          bathrooms: input.bathrooms ?? null,
          floorAreaM2: input.floorAreaM2 ?? null,
          bedCount: input.bedCount ?? null,
          status: input.status,
          notes: input.notes ?? null,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ApiError('conflict', `a unit labelled "${input.label}" already exists`);
      throw err;
    }
    await recordAudit(tx, identity, {
      action: 'unit.created',
      entityType: 'unit',
      entityId: row!.id,
      organizationId: property.organizationId,
      after: { propertyId, label: input.label, unitType: input.unitType, status: input.status },
      correlationId: options.correlationId,
    });
    return toUnitDto(row!);
  });
}

export async function updateUnit(
  identity: RequestIdentity,
  propertyId: string,
  unitId: string,
  input: UnitUpdate,
  options: ServiceOptions = {},
): Promise<UnitDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    const current = await loadUnit(tx, propertyId, unitId);
    if (!current) throw new ApiError('not_found', 'unit not found');
    const patch: Partial<UnitInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.unitType !== undefined) patch.unitType = input.unitType;
    if (input.bedrooms !== undefined) patch.bedrooms = input.bedrooms;
    if (input.bathrooms !== undefined) patch.bathrooms = input.bathrooms;
    if (input.floorAreaM2 !== undefined) patch.floorAreaM2 = input.floorAreaM2;
    if (input.bedCount !== undefined) patch.bedCount = input.bedCount;
    if (input.status !== undefined) patch.status = input.status;
    if (input.notes !== undefined) patch.notes = input.notes;
    let row: UnitRow | undefined;
    try {
      [row] = await tx.update(schema.units).set(patch).where(eq(schema.units.id, unitId)).returning();
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ApiError('conflict', `a unit labelled "${input.label}" already exists`);
      throw err;
    }
    await recordAudit(tx, identity, {
      action: 'unit.updated',
      entityType: 'unit',
      entityId: unitId,
      organizationId: property.organizationId,
      before: { label: current.label, unitType: current.unitType, status: current.status },
      after: patch,
      correlationId: options.correlationId,
    });
    return toUnitDto(row!);
  });
}

export async function deleteUnit(
  identity: RequestIdentity,
  propertyId: string,
  unitId: string,
  options: ServiceOptions = {},
): Promise<void> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  await withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    const current = await loadUnit(tx, propertyId, unitId);
    if (!current) throw new ApiError('not_found', 'unit not found');
    try {
      await tx.delete(schema.units).where(eq(schema.units.id, unitId));
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new ApiError(
          'conflict',
          'this unit is referenced by leases or other records; mark it unavailable instead',
        );
      }
      throw err;
    }
    await recordAudit(tx, identity, {
      action: 'unit.deleted',
      entityType: 'unit',
      entityId: unitId,
      organizationId: property.organizationId,
      before: { propertyId, label: current.label, unitType: current.unitType, status: current.status },
      correlationId: options.correlationId,
    });
  });
}
