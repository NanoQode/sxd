import 'server-only';
import type {
  GeoJsonPolygonDto,
  OwnerAuthorityDto,
  OwnerAuthorityStatus,
  ParcelDto,
  PropertyDto,
  UnitDto,
} from '@simplexd/contracts';
import type { schema } from '@simplexd/db';
import { iso } from '@/server/assignments/shared';
import { toDeclaredAreaDto } from './areas';

export function toPropertyDto(row: typeof schema.properties.$inferSelect): PropertyDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind,
    address: row.address ?? null,
    marketId: row.marketId,
    neighborhoodId: row.neighborhoodId,
    estateId: row.estateId,
    location: row.location ?? null,
    preciseLocationPublic: row.preciseLocationPublic,
    landArea: toDeclaredAreaDto(
      row.landAreaDeclaredValue,
      row.landAreaDeclaredUnit,
      row.landAreaM2,
    ),
    floorAreaM2: row.floorAreaM2,
    titleType: row.titleType,
    titleStatus: row.titleStatus,
    titleNote: row.titleNote,
    status: row.status === 'archived' ? 'archived' : 'active',
    createdBy: row.createdBy,
    archivedAt: iso(row.archivedAt),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ParcelRow = Omit<typeof schema.parcels.$inferSelect, 'boundary'> & {
  /** GeoJSON text produced by ST_AsGeoJSON, never raw EWKB. */
  boundaryGeoJson: string | null;
};

export function toParcelDto(row: ParcelRow): ParcelDto {
  let boundary: GeoJsonPolygonDto | null = null;
  if (row.boundaryGeoJson) {
    const parsed = JSON.parse(row.boundaryGeoJson) as {
      type: string;
      coordinates: GeoJsonPolygonDto['coordinates'];
    };
    if (parsed.type === 'Polygon') boundary = { type: 'Polygon', coordinates: parsed.coordinates };
  }
  return {
    id: row.id,
    propertyId: row.propertyId,
    reference: row.reference,
    surveyPlanRef: row.surveyPlanRef,
    area: toDeclaredAreaDto(row.declaredValue, row.declaredUnit, row.areaM2),
    boundary,
    titleDisclosures: (row.titleDisclosures as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toUnitDto(row: typeof schema.units.$inferSelect): UnitDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    label: row.label,
    unitType: row.unitType,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    floorAreaM2: row.floorAreaM2,
    bedCount: row.bedCount,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A verified authority whose expiry date has passed reads as expired. */
export function effectiveAuthorityStatus(
  status: OwnerAuthorityStatus,
  expiresAt: Date | null,
  now = new Date(),
): OwnerAuthorityStatus {
  if (status === 'verified' && expiresAt && expiresAt.getTime() <= now.getTime()) return 'expired';
  return status;
}

export function toOwnerAuthorityDto(
  row: typeof schema.ownerAuthorities.$inferSelect,
  now = new Date(),
): OwnerAuthorityDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    ownerName: row.ownerName,
    authorityDocumentFileId: row.authorityDocumentFileId,
    status: row.status,
    effectiveStatus: effectiveAuthorityStatus(row.status, row.expiresAt, now),
    verifiedBy: row.verifiedBy,
    verifiedAt: iso(row.verifiedAt),
    expiresAt: iso(row.expiresAt),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
