import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  geometryMultiPolygon,
  geometryPoint,
  id,
  jsonObject,
  timestamps,
  tstz,
  version,
} from './_common';
import { user } from './auth';

export const geopoliticalZoneEnum = pgEnum('geopolitical_zone', [
  'NC',
  'NE',
  'NW',
  'SE',
  'SS',
  'SW',
]);

export const publicationStateEnum = pgEnum('publication_state', [
  'draft',
  'in_review',
  'published',
  'unpublished',
  'archived',
]);

export const serviceAvailabilityEnum = pgEnum('service_availability', [
  'pending_operations_confirmation',
  'available',
  'limited',
  'on_request',
  'unavailable',
]);

export const recommendationStatusEnum = pgEnum('recommendation_status', [
  'insufficient_local_evidence',
  'assumption_mode_only',
  'eligible',
  'gated_by_policy',
]);

export const licenseRightsEnum = pgEnum('license_rights', [
  'unknown',
  'attribution_required',
  'licensed_commercial',
  'first_party',
  'restricted_factual_reference',
]);

export const marketFlagTypeEnum = pgEnum('market_flag_type', [
  'geographic_exclusion',
  'title_stop',
  'site_restriction',
  'flood_alert',
  'security_advisory',
  'data_dispute',
]);

export const countries = pgTable('countries', {
  code: text().primaryKey(),
  name: text().notNull(),
  currency: text().notNull().default('NGN'),
  defaultTimeZone: text().notNull().default('Africa/Lagos'),
});

export const states = pgTable(
  'states',
  {
    id: id(),
    countryCode: text()
      .notNull()
      .references(() => countries.code),
    name: text().notNull(),
    code: text(),
    geopoliticalZone: geopoliticalZoneEnum().notNull(),
    isFederalCapital: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('states_country_name_unique').on(t.countryCode, t.name)],
);

/** Reference sources for coordinates, observations and facility leads. */
export const sources = pgTable('sources', {
  id: id(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  publisher: text(),
  url: text(),
  dataUrl: text(),
  licenseNote: text(),
  licenseRights: licenseRightsEnum().notNull().default('unknown'),
  useNote: text(),
  retrievedAt: date({ mode: 'string' }),
  createdBy: text().references(() => user.id),
  ...timestamps(),
});

export const markets = pgTable(
  'markets',
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    aliases: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    countryCode: text()
      .notNull()
      .references(() => countries.code),
    stateId: uuid()
      .notNull()
      .references(() => states.id),
    geopoliticalZone: geopoliticalZoneEnum().notNull(),
    displayOrder: integer().notNull().default(0),
    selectionBasis: text(),
    /** WGS84 point; GeoJSON order longitude, latitude. */
    location: geometryPoint().notNull(),
    coordinateSourceId: uuid().references(() => sources.id),
    coordinateAccuracy: text(),
    sourceCityName: text(),
    parentMarketId: uuid().references((): AnyPgColumn => markets.id),
    overlapNote: text(),
    serviceAvailability: serviceAvailabilityEnum()
      .notNull()
      .default('pending_operations_confirmation'),
    publicationState: publicationStateEnum().notNull().default('draft'),
    profileMarkdown: text(),
    supplyMappingMethod: text(),
    recommendationStatus: recommendationStatusEnum()
      .notNull()
      .default('insufficient_local_evidence'),
    researchTasks: jsonObject<string[]>(),
    lastResearchedAt: date({ mode: 'string' }),
    lastReviewedAt: tstz(),
    reviewedBy: text().references(() => user.id),
    publishedAt: tstz(),
    publishedBy: text().references(() => user.id),
    archivedAt: tstz(),
    mergedIntoMarketId: uuid().references((): AnyPgColumn => markets.id),
    /** Hash of the last imported seed record, to detect human edits on re-import. */
    importFingerprint: text(),
    importedAt: tstz(),
    humanEditedAt: tstz(),
    version: version(),
    createdBy: text().references(() => user.id),
    updatedBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [
    index('markets_location_gix').using('gist', t.location),
    index('markets_state_idx').on(t.stateId),
    index('markets_publication_idx').on(t.publicationState),
  ],
);

export const marketRevisions = pgTable(
  'market_revisions',
  {
    id: id(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    version: integer().notNull(),
    snapshot: jsonb().notNull(),
    changeReason: text(),
    changedBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('market_revisions_unique').on(t.marketId, t.version)],
);

export const neighborhoods = pgTable(
  'neighborhoods',
  {
    id: id(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    slug: text().notNull(),
    name: text().notNull(),
    boundary: geometryMultiPolygon(),
    centroid: geometryPoint(),
    boundarySourceId: uuid().references(() => sources.id),
    boundaryNote: text(),
    publicationState: publicationStateEnum().notNull().default('draft'),
    profileMarkdown: text(),
    version: version(),
    createdBy: text().references(() => user.id),
    updatedBy: text().references(() => user.id),
    archivedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('neighborhoods_market_slug_unique').on(t.marketId, t.slug),
    index('neighborhoods_boundary_gix').using('gist', t.boundary),
  ],
);

export const marketFlags = pgTable(
  'market_flags',
  {
    id: id(),
    marketId: uuid().references(() => markets.id),
    neighborhoodId: uuid().references(() => neighborhoods.id),
    flagType: marketFlagTypeEnum().notNull(),
    active: boolean().notNull().default(true),
    note: text().notNull(),
    sourceId: uuid().references(() => sources.id),
    validFrom: date({ mode: 'string' }),
    validUntil: date({ mode: 'string' }),
    approvedBy: text().references(() => user.id),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('market_flags_market_idx').on(t.marketId, t.active)],
);
