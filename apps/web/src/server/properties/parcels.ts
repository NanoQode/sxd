import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { ApiError, type ParcelCreate, type ParcelDto, type ParcelUpdate } from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  requireUserId,
  type ServiceOptions,
} from '@/server/assignments/shared';
import { requireProperty } from './access';
import { normaliseArea } from './areas';
import { toParcelDto, type ParcelRow } from './dto';

type ParcelInsert = typeof schema.parcels.$inferInsert;

/**
 * Parcels: survey references, declared area and an optional boundary polygon.
 * Boundaries are exchanged as GeoJSON Polygon coordinates and read back with
 * ST_AsGeoJSON so raw EWKB never reaches the API.
 */

const parcelColumns = {
  id: schema.parcels.id,
  propertyId: schema.parcels.propertyId,
  reference: schema.parcels.reference,
  surveyPlanRef: schema.parcels.surveyPlanRef,
  areaM2: schema.parcels.areaM2,
  declaredValue: schema.parcels.declaredValue,
  declaredUnit: schema.parcels.declaredUnit,
  titleDisclosures: schema.parcels.titleDisclosures,
  createdAt: schema.parcels.createdAt,
  updatedAt: schema.parcels.updatedAt,
  boundaryGeoJson: sql<string | null>`ST_AsGeoJSON(${schema.parcels.boundary})`,
};

async function loadParcel(tx: DbExecutor, propertyId: string, parcelId: string): Promise<ParcelRow | null> {
  const rows = await tx
    .select(parcelColumns)
    .from(schema.parcels)
    .where(and(eq(schema.parcels.id, parcelId), eq(schema.parcels.propertyId, propertyId)));
  return rows[0] ?? null;
}

function boundaryValue(coordinates: ParcelCreate['boundary']): string | null | undefined {
  if (coordinates === undefined) return undefined;
  if (coordinates === null) return null;
  return JSON.stringify({ type: 'Polygon', coordinates });
}

function areaPatch(area: ParcelCreate['area']): Pick<ParcelInsert, 'areaM2' | 'declaredValue' | 'declaredUnit'> {
  if (!area) return { areaM2: null, declaredValue: null, declaredUnit: null };
  const n = normaliseArea(area);
  return { areaM2: n.m2, declaredValue: n.declaredValue, declaredUnit: n.declaredUnit };
}

async function assertValidBoundary(tx: DbExecutor, geoJson: string): Promise<void> {
  const res = await tx.execute<{ valid: boolean; reason: string | null }>(sql`
    select ST_IsValid(g) as valid, ST_IsValidReason(g) as reason
    from (select ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326) as g) s
  `);
  const row = res.rows[0];
  if (!row?.valid) {
    throw new ApiError('validation_failed', 'boundary polygon is not valid', {
      details: [{ path: 'boundary', message: row?.reason ?? 'invalid geometry' }],
    });
  }
}

export async function listParcels(identity: RequestIdentity, propertyId: string): Promise<ParcelDto[]> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    await requireProperty(tx, identity, propertyId, 'read');
    const rows = await tx
      .select(parcelColumns)
      .from(schema.parcels)
      .where(eq(schema.parcels.propertyId, propertyId))
      .orderBy(asc(schema.parcels.createdAt), asc(schema.parcels.id));
    return rows.map(toParcelDto);
  });
}

export async function createParcel(
  identity: RequestIdentity,
  propertyId: string,
  input: ParcelCreate,
  options: ServiceOptions = {},
): Promise<ParcelDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    const boundary = boundaryValue(input.boundary);
    if (boundary) await assertValidBoundary(tx, boundary);
    const [inserted] = await tx
      .insert(schema.parcels)
      .values({
        propertyId,
        reference: input.reference ?? null,
        surveyPlanRef: input.surveyPlanRef ?? null,
        ...areaPatch(input.area),
        boundary: boundary ?? null,
        titleDisclosures: input.titleDisclosures ?? null,
      })
      .returning({ id: schema.parcels.id });
    const row = await loadParcel(tx, propertyId, inserted!.id);
    await recordAudit(tx, identity, {
      action: 'parcel.created',
      entityType: 'parcel',
      entityId: inserted!.id,
      organizationId: property.organizationId,
      after: { propertyId, reference: input.reference ?? null, surveyPlanRef: input.surveyPlanRef ?? null },
      correlationId: options.correlationId,
    });
    return toParcelDto(row!);
  });
}

export async function updateParcel(
  identity: RequestIdentity,
  propertyId: string,
  parcelId: string,
  input: ParcelUpdate,
  options: ServiceOptions = {},
): Promise<ParcelDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    const current = await loadParcel(tx, propertyId, parcelId);
    if (!current) throw new ApiError('not_found', 'parcel not found');
    const patch: Partial<ParcelInsert> = {};
    if (input.reference !== undefined) patch.reference = input.reference;
    if (input.surveyPlanRef !== undefined) patch.surveyPlanRef = input.surveyPlanRef;
    if (input.area !== undefined) Object.assign(patch, areaPatch(input.area));
    if (input.titleDisclosures !== undefined) patch.titleDisclosures = input.titleDisclosures;
    const boundary = boundaryValue(input.boundary);
    if (boundary !== undefined) {
      if (boundary) await assertValidBoundary(tx, boundary);
      patch.boundary = boundary;
    }
    await tx.update(schema.parcels).set(patch).where(eq(schema.parcels.id, parcelId));
    const row = await loadParcel(tx, propertyId, parcelId);
    await recordAudit(tx, identity, {
      action: 'parcel.updated',
      entityType: 'parcel',
      entityId: parcelId,
      organizationId: property.organizationId,
      before: {
        reference: current.reference,
        surveyPlanRef: current.surveyPlanRef,
        declaredValue: current.declaredValue,
        declaredUnit: current.declaredUnit,
      },
      after: { ...patch, boundary: patch.boundary === undefined ? undefined : Boolean(patch.boundary) },
      correlationId: options.correlationId,
    });
    return toParcelDto(row!);
  });
}

export async function deleteParcel(
  identity: RequestIdentity,
  propertyId: string,
  parcelId: string,
  options: ServiceOptions = {},
): Promise<void> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  await withActor(getDb(), ctx, async (tx) => {
    const property = await requireProperty(tx, identity, propertyId, 'manage');
    const current = await loadParcel(tx, propertyId, parcelId);
    if (!current) throw new ApiError('not_found', 'parcel not found');
    await tx.delete(schema.parcels).where(eq(schema.parcels.id, parcelId));
    await recordAudit(tx, identity, {
      action: 'parcel.deleted',
      entityType: 'parcel',
      entityId: parcelId,
      organizationId: property.organizationId,
      before: {
        propertyId,
        reference: current.reference,
        surveyPlanRef: current.surveyPlanRef,
        declaredValue: current.declaredValue,
        declaredUnit: current.declaredUnit,
        areaM2: current.areaM2,
      },
      correlationId: options.correlationId,
    });
  });
}
