import { z } from 'zod';
import {
  cursorPaginationQuerySchema,
  decimalStringSchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  uuidSchema,
} from './common';

/**
 * Private property assets (distinct from public listings): properties,
 * parcels, units and owner authorities. Areas travel as decimal strings; the
 * declared value and unit a customer typed are preserved verbatim next to the
 * normalised square-metre figure. Points are {lon, lat}; parcel boundaries are
 * GeoJSON Polygon coordinates in WGS84.
 */

export const propertyKindSchema = z.enum([
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
]);
export type PropertyKind = z.infer<typeof propertyKindSchema>;

export const titleStatusSchema = z.enum([
  'unknown',
  'documents_received',
  'verification_in_progress',
  'verified',
  'issues_found',
  'disputed',
]);
export type TitleStatus = z.infer<typeof titleStatusSchema>;

export const propertyStatusSchema = z.enum(['active', 'archived']);
export type PropertyStatus = z.infer<typeof propertyStatusSchema>;

export const unitStatusSchema = z.enum(['vacant', 'occupied', 'unavailable']);
export type UnitStatus = z.infer<typeof unitStatusSchema>;

export const ownerAuthorityStatusSchema = z.enum(['pending', 'verified', 'rejected', 'expired']);
export type OwnerAuthorityStatus = z.infer<typeof ownerAuthorityStatusSchema>;

export const geoPointSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type GeoPointDto = z.infer<typeof geoPointSchema>;

const positionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** GeoJSON Polygon coordinates: one outer ring plus optional holes, each closed. */
export const polygonCoordinatesSchema = z
  .array(z.array(positionSchema).min(4).max(5000))
  .min(1)
  .max(20)
  .refine(
    (rings) =>
      rings.every((ring) => {
        const first = ring[0];
        const last = ring[ring.length - 1];
        return Boolean(first && last && first[0] === last[0] && first[1] === last[1]);
      }),
    'each ring must be closed (first and last positions equal)',
  );
export type PolygonCoordinates = z.infer<typeof polygonCoordinatesSchema>;

export const geoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: polygonCoordinatesSchema,
});
export type GeoJsonPolygonDto = z.infer<typeof geoJsonPolygonSchema>;

/**
 * Units a customer may declare an area in. `plot` has no fixed size in
 * Nigeria (it varies by state and estate), so plots are kept as declared and
 * never converted to square metres.
 */
export const areaUnitSchema = z.enum(['m2', 'sqft', 'ha', 'acre', 'plot']);
export type AreaUnit = z.infer<typeof areaUnitSchema>;

export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (v) => !v.startsWith('-') && Number(v) > 0 && Number(v) < 1e11,
  'must be a positive decimal below 100,000,000,000',
);

export const declaredAreaInputSchema = z.object({
  value: positiveDecimalStringSchema,
  unit: areaUnitSchema,
});
export type DeclaredAreaInput = z.infer<typeof declaredAreaInputSchema>;

export const declaredAreaDtoSchema = z.object({
  /** Exactly what was declared, never rewritten. */
  declaredValue: z.string(),
  declaredUnit: z.string(),
  /** Normalised square metres, or null when the declared unit cannot be converted (plots). */
  m2: z.string().nullable(),
});
export type DeclaredAreaDto = z.infer<typeof declaredAreaDtoSchema>;

export const propertyAddressSchema = z.object({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  postcode: z.string().trim().max(20).optional(),
  country: z.string().trim().length(2).optional(),
});
export type PropertyAddress = z.infer<typeof propertyAddressSchema>;

export const propertyCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  kind: propertyKindSchema,
  address: propertyAddressSchema.nullable().optional(),
  marketId: uuidSchema.nullable().optional(),
  neighborhoodId: uuidSchema.nullable().optional(),
  estateId: uuidSchema.nullable().optional(),
  location: geoPointSchema.nullable().optional(),
  preciseLocationPublic: z.boolean().default(false),
  landArea: declaredAreaInputSchema.nullable().optional(),
  /** Floor areas are accepted in square metres only; nothing is converted silently. */
  floorAreaM2: positiveDecimalStringSchema.nullable().optional(),
  titleType: z.string().trim().max(120).nullable().optional(),
  titleStatus: titleStatusSchema.default('unknown'),
  titleNote: z.string().trim().max(4000).nullable().optional(),
  /** Staff creating a property on a customer's behalf name the organisation explicitly. */
  organizationId: z.string().min(1).max(64).optional(),
});
export type PropertyCreate = z.infer<typeof propertyCreateSchema>;

export const propertyUpdateSchema = propertyCreateSchema
  .omit({ organizationId: true })
  .partial()
  .extend({ expectedVersion: expectedVersionSchema })
  .refine((v) => Object.keys(v).length > 1, 'nothing to update');
export type PropertyUpdate = z.infer<typeof propertyUpdateSchema>;

export const propertyArchiveSchema = z.object({
  expectedVersion: expectedVersionSchema,
  reason: z.string().trim().max(2000).optional(),
});
export type PropertyArchive = z.infer<typeof propertyArchiveSchema>;

export const propertyListQuerySchema = cursorPaginationQuerySchema.extend({
  kind: propertyKindSchema.optional(),
  marketId: uuidSchema.optional(),
  status: propertyStatusSchema.default('active'),
  /** Case-insensitive match on the name or the address city. */
  q: z.string().trim().min(1).max(120).optional(),
  /** Staff may scope the list to one customer organisation. */
  organizationId: z.string().min(1).max(64).optional(),
});
export type PropertyListQuery = z.infer<typeof propertyListQuerySchema>;

export const propertyDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  name: z.string(),
  kind: propertyKindSchema,
  address: propertyAddressSchema.nullable(),
  marketId: uuidSchema.nullable(),
  neighborhoodId: uuidSchema.nullable(),
  estateId: uuidSchema.nullable(),
  location: geoPointSchema.nullable(),
  preciseLocationPublic: z.boolean(),
  landArea: declaredAreaDtoSchema.nullable(),
  floorAreaM2: z.string().nullable(),
  titleType: z.string().nullable(),
  titleStatus: titleStatusSchema,
  titleNote: z.string().nullable(),
  status: propertyStatusSchema,
  createdBy: z.string().nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PropertyDto = z.infer<typeof propertyDtoSchema>;

export const propertyOverviewSchema = z.object({
  property: propertyDtoSchema,
  units: z.object({
    total: z.number().int().nonnegative(),
    occupied: z.number().int().nonnegative(),
    vacant: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    /** Occupied units over total units, as a percentage rounded to one decimal; null when there are no units. */
    occupancyPercent: z.number().nullable(),
  }),
  parcelsCount: z.number().int().nonnegative(),
  ownerAuthority: z
    .object({
      id: uuidSchema,
      status: ownerAuthorityStatusSchema,
      /** Status after applying the expiry date; `expired` when a verified authority has lapsed. */
      effectiveStatus: ownerAuthorityStatusSchema,
      expiresAt: isoDateTimeSchema.nullable(),
      verifiedAt: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  linkedProjectsCount: z.number().int().nonnegative(),
  documents: z.object({
    /** Files that passed the malware scan and can be opened. */
    available: z.number().int().nonnegative(),
    /** Files uploaded but not yet cleared by the scanner. */
    pending: z.number().int().nonnegative(),
  }),
});
export type PropertyOverview = z.infer<typeof propertyOverviewSchema>;

/* ---------------------------------------------------------------------- */
/* Parcels                                                                 */
/* ---------------------------------------------------------------------- */

export const parcelCreateSchema = z.object({
  reference: z.string().trim().max(120).nullable().optional(),
  surveyPlanRef: z.string().trim().max(120).nullable().optional(),
  area: declaredAreaInputSchema.nullable().optional(),
  boundary: polygonCoordinatesSchema.nullable().optional(),
  titleDisclosures: z.record(z.string().max(64), z.unknown()).nullable().optional(),
});
export type ParcelCreate = z.infer<typeof parcelCreateSchema>;

export const parcelUpdateSchema = parcelCreateSchema.refine(
  (v) => Object.keys(v).length > 0,
  'nothing to update',
);
export type ParcelUpdate = z.infer<typeof parcelUpdateSchema>;

export const parcelDtoSchema = z.object({
  id: uuidSchema,
  propertyId: uuidSchema,
  reference: z.string().nullable(),
  surveyPlanRef: z.string().nullable(),
  area: declaredAreaDtoSchema.nullable(),
  boundary: geoJsonPolygonSchema.nullable(),
  titleDisclosures: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ParcelDto = z.infer<typeof parcelDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Units                                                                   */
/* ---------------------------------------------------------------------- */

export const unitCreateSchema = z.object({
  label: z.string().trim().min(1).max(60),
  unitType: z.string().trim().min(1).max(60),
  bedrooms: z.number().int().min(0).max(50).nullable().optional(),
  bathrooms: z.number().int().min(0).max(50).nullable().optional(),
  floorAreaM2: positiveDecimalStringSchema.nullable().optional(),
  bedCount: z.number().int().min(0).max(500).nullable().optional(),
  status: unitStatusSchema.default('vacant'),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UnitCreate = z.infer<typeof unitCreateSchema>;

export const unitUpdateSchema = unitCreateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UnitUpdate = z.infer<typeof unitUpdateSchema>;

export const unitDtoSchema = z.object({
  id: uuidSchema,
  propertyId: uuidSchema,
  label: z.string(),
  unitType: z.string(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  floorAreaM2: z.string().nullable(),
  bedCount: z.number().int().nullable(),
  status: unitStatusSchema,
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type UnitDto = z.infer<typeof unitDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Owner authorities                                                       */
/* ---------------------------------------------------------------------- */

export const ownerAuthoritySubmitSchema = z.object({
  ownerName: z.string().trim().min(2).max(160),
  /** A file_objects row of the same organisation that is not quarantined or rejected. */
  authorityDocumentFileId: uuidSchema,
  note: z.string().trim().max(2000).nullable().optional(),
});
export type OwnerAuthoritySubmit = z.infer<typeof ownerAuthoritySubmitSchema>;

export const ownerAuthorityVerifySchema = z.object({
  /** When the verification lapses; verified authorities read as `expired` afterwards. */
  expiresAt: isoDateTimeSchema.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});
export type OwnerAuthorityVerify = z.infer<typeof ownerAuthorityVerifySchema>;

export const ownerAuthorityRejectSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
});
export type OwnerAuthorityReject = z.infer<typeof ownerAuthorityRejectSchema>;

export const ownerAuthorityDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  propertyId: uuidSchema,
  ownerName: z.string(),
  authorityDocumentFileId: uuidSchema.nullable(),
  status: ownerAuthorityStatusSchema,
  effectiveStatus: ownerAuthorityStatusSchema,
  verifiedBy: z.string().nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type OwnerAuthorityDto = z.infer<typeof ownerAuthorityDtoSchema>;
