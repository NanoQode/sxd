import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currency,
  geometryPoint,
  geometryPolygon,
  id,
  jsonObject,
  kobo,
  koboNotNull,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';
import { markets, neighborhoods } from './geography';

export const propertyKindEnum = pgEnum('property_kind', [
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
]);

export const titleStatusEnum = pgEnum('title_status', [
  'unknown',
  'documents_received',
  'verification_in_progress',
  'verified',
  'issues_found',
  'disputed',
]);

export const listingKindEnum = pgEnum('listing_kind', ['sale', 'lease', 'short_stay']);

export const listingStatusEnum = pgEnum('listing_status', [
  'draft',
  'in_moderation',
  'published',
  'paused',
  'expired',
  'withdrawn',
  'archived',
  'rejected',
]);

export const ownerAuthorityStatusEnum = pgEnum('owner_authority_status', [
  'pending',
  'verified',
  'rejected',
  'expired',
]);

export const offerStatusEnum = pgEnum('offer_status', [
  'draft',
  'submitted',
  'countered',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
]);

export const viewingStatusEnum = pgEnum('viewing_status', [
  'requested',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
]);

export const unitStatusEnum = pgEnum('unit_status', ['vacant', 'occupied', 'unavailable']);

export const properties = pgTable(
  'properties',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    name: text().notNull(),
    kind: propertyKindEnum().notNull(),
    address: jsonObject<{
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
    }>(),
    marketId: uuid().references(() => markets.id),
    neighborhoodId: uuid().references(() => neighborhoods.id),
    estateId: uuid(),
    location: geometryPoint(),
    preciseLocationPublic: boolean().notNull().default(false),
    landAreaM2: numeric({ precision: 14, scale: 2 }),
    landAreaDeclaredValue: numeric({ precision: 14, scale: 3 }),
    landAreaDeclaredUnit: text(),
    floorAreaM2: numeric({ precision: 14, scale: 2 }),
    titleType: text(),
    titleStatus: titleStatusEnum().notNull().default('unknown'),
    titleNote: text(),
    status: text().notNull().default('active'),
    createdBy: text().references(() => user.id),
    archivedAt: tstz(),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('properties_org_idx').on(t.organizationId),
    index('properties_market_idx').on(t.marketId),
    index('properties_location_gix').using('gist', t.location),
  ],
);

export const parcels = pgTable(
  'parcels',
  {
    id: id(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    reference: text(),
    surveyPlanRef: text(),
    areaM2: numeric({ precision: 14, scale: 2 }),
    declaredValue: numeric({ precision: 14, scale: 3 }),
    declaredUnit: text(),
    boundary: geometryPolygon(),
    titleDisclosures: jsonb(),
    ...timestamps(),
  },
  (t) => [index('parcels_property_idx').on(t.propertyId)],
);

export const units = pgTable(
  'units',
  {
    id: id(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    label: text().notNull(),
    unitType: text().notNull(),
    bedrooms: integer(),
    bathrooms: integer(),
    floorAreaM2: numeric({ precision: 12, scale: 2 }),
    bedCount: integer(),
    status: unitStatusEnum().notNull().default('vacant'),
    notes: text(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('units_property_label_unique').on(t.propertyId, t.label)],
);

export const ownerAuthorities = pgTable(
  'owner_authorities',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    ownerName: text().notNull(),
    authorityDocumentFileId: uuid(),
    status: ownerAuthorityStatusEnum().notNull().default('pending'),
    verifiedBy: text().references(() => user.id),
    verifiedAt: tstz(),
    expiresAt: tstz(),
    note: text(),
    ...timestamps(),
  },
  (t) => [index('owner_authorities_property_idx').on(t.propertyId)],
);

export const listings = pgTable(
  'listings',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    kind: listingKindEnum().notNull(),
    status: listingStatusEnum().notNull().default('draft'),
    slug: text().notNull().unique(),
    currentVersion: integer().notNull().default(0),
    publishedVersion: integer(),
    ownerAuthorityId: uuid().references(() => ownerAuthorities.id),
    publishedAt: tstz(),
    publishedBy: text().references(() => user.id),
    expiresAt: tstz(),
    availabilityConfirmedAt: tstz(),
    moderationNote: text(),
    moderatedBy: text().references(() => user.id),
    duplicateOfListingId: uuid(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('listings_status_idx').on(t.status, t.kind),
    index('listings_property_idx').on(t.propertyId),
  ],
);

export interface VerificationScope {
  checks: Array<{
    item: string;
    checkedBy: string;
    checkedAt: string;
    expiresAt?: string;
    result: string;
  }>;
  summary?: string;
}

export const listingRevisions = pgTable(
  'listing_revisions',
  {
    id: id(),
    listingId: uuid()
      .notNull()
      .references(() => listings.id),
    version: integer().notNull(),
    title: text().notNull(),
    descriptionMarkdown: text(),
    priceKobo: kobo(),
    priceBasis: text(),
    currency: currency(),
    areaM2: numeric({ precision: 14, scale: 2 }),
    tenure: text(),
    titleDisclosure: text(),
    availability: text(),
    verificationScope: jsonObject<VerificationScope>(),
    mediaFileIds: jsonObject<string[]>(),
    publicLocationPrecision: text().notNull().default('market'),
    seo: jsonb(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('listing_revisions_unique').on(t.listingId, t.version)],
);

export const offers = pgTable(
  'offers',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    listingId: uuid().references(() => listings.id),
    propertyId: uuid().references(() => properties.id),
    serviceRequestId: uuid(),
    counterpartyOrganizationId: text().references(() => organization.id),
    amountKobo: koboNotNull(),
    currency: currency(),
    conditions: jsonb(),
    status: offerStatusEnum().notNull().default('draft'),
    negotiationLog: jsonb(),
    expiresAt: tstz(),
    decidedAt: tstz(),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [
    index('offers_listing_idx').on(t.listingId),
    index('offers_sr_idx').on(t.serviceRequestId),
  ],
);

export const viewings = pgTable(
  'viewings',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    listingId: uuid().references(() => listings.id),
    propertyId: uuid().references(() => properties.id),
    appointmentId: uuid(),
    requestedByUserId: text().references(() => user.id),
    status: viewingStatusEnum().notNull().default('requested'),
    scheduledAt: tstz(),
    feedback: text(),
    ...timestamps(),
  },
  (t) => [index('viewings_listing_idx').on(t.listingId)],
);

export const savedSearches = pgTable(
  'saved_searches',
  {
    id: id(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text().references(() => organization.id),
    name: text().notNull(),
    criteria: jsonb().notNull(),
    alertsEnabled: boolean().notNull().default(false),
    lastRunAt: tstz(),
    ...timestamps(),
  },
  (t) => [index('saved_searches_user_idx').on(t.userId)],
);

export const shortlists = pgTable(
  'shortlists',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    serviceRequestId: uuid(),
    name: text().notNull(),
    status: text().notNull().default('open'),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('shortlists_sr_idx').on(t.serviceRequestId)],
);

export const shortlistItems = pgTable(
  'shortlist_items',
  {
    id: id(),
    shortlistId: uuid()
      .notNull()
      .references(() => shortlists.id, { onDelete: 'cascade' }),
    listingId: uuid().references(() => listings.id),
    externalReference: text(),
    title: text().notNull(),
    priceKobo: kobo(),
    notes: text(),
    customerRating: integer(),
    customerFeedback: text(),
    status: text().notNull().default('candidate'),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('shortlist_items_shortlist_idx').on(t.shortlistId)],
);
