import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, jsonObject, timestamps, tstz, updatedAt } from './_common';

/*
 * Tables managed by better-auth (identity, sessions, credentials, organisations,
 * invitations and two-factor). Field names follow better-auth's model contract
 * (see docs/architecture/auth.md); the physical columns are snake_case.
 */

export const user = pgTable(
  'user',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // two-factor plugin
    twoFactorEnabled: boolean().default(false),
    // admin plugin
    role: text(),
    banned: boolean().default(false),
    banReason: text(),
    banExpires: tstz(),
  },
  (t) => [uniqueIndex('user_email_unique').on(sql`lower(${t.email})`)],
);

export const session = pgTable(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: tstz().notNull(),
    token: text().notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text(),
    impersonatedBy: text(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: tstz(),
    refreshTokenExpiresAt: tstz(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: tstz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const organization = pgTable('organization', {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  createdAt: createdAt(),
  metadata: text(),
});

export const member = pgTable(
  'member',
  {
    id: text().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text().notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('member_org_user_unique').on(t.organizationId, t.userId),
    index('member_user_idx').on(t.userId),
  ],
);

export const invitation = pgTable(
  'invitation',
  {
    id: text().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text(),
    status: text().notNull().default('pending'),
    expiresAt: tstz().notNull(),
    createdAt: createdAt(),
    inviterId: text()
      .notNull()
      .references(() => user.id),
  },
  (t) => [
    index('invitation_org_idx').on(t.organizationId),
    index('invitation_email_idx').on(t.email),
  ],
);

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text().primaryKey(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean().default(true),
    failedVerificationCount: integer().default(0),
    lockedUntil: tstz(),
  },
  (t) => [index('two_factor_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------------------- */
/* SimplexD identity extensions                                               */
/* ------------------------------------------------------------------------- */

export const themePreferenceEnum = pgEnum('theme_preference', ['system', 'light', 'dark']);
export const ownershipTypeEnum = pgEnum('ownership_type', ['individual', 'company']);
export const organizationKindEnum = pgEnum('organization_kind', [
  'customer',
  'staff',
  'partner',
  'estate',
]);

export const staffRoleEnum = pgEnum('staff_role', [
  'super_admin',
  'operations_manager',
  'project_manager',
  'inspector',
  'finance',
  'data_editor',
  'data_approver',
  'content_editor',
  'support',
]);

export const partnerTypeEnum = pgEnum('partner_type', [
  'contractor',
  'inspector',
  'surveyor',
  'legal',
  'architect',
  'quantity_surveyor',
  'valuer',
  'vendor',
  'agent',
  'other',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'unverified',
  'pending',
  'verified',
  'expired',
  'rejected',
]);

export const grantLevelEnum = pgEnum('grant_level', ['view', 'comment', 'edit', 'approve']);

export const userProfiles = pgTable('user_profiles', {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  phoneE164: text(),
  phoneVerifiedAt: tstz(),
  timeZone: text().notNull().default('Africa/Lagos'),
  locale: text().notNull().default('en-NG'),
  themePreference: themePreferenceEnum().notNull().default('system'),
  reduceMotion: boolean().notNull().default(false),
  ownershipType: ownershipTypeEnum(),
  goals: jsonObject<string[]>(),
  diaspora: boolean(),
  countryOfResidence: text(),
  marketingConsentAt: tstz(),
  onboardingCompletedAt: tstz(),
  ...timestamps(),
});

export const organizationProfiles = pgTable('organization_profiles', {
  organizationId: text()
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  kind: organizationKindEnum().notNull().default('customer'),
  legalName: text(),
  ownershipType: ownershipTypeEnum().notNull().default('individual'),
  countryCode: text().notNull().default('NG'),
  address: jsonObject<Record<string, string>>(),
  taxIdMasked: text(),
  brandThemeDefault: themePreferenceEnum(),
  defaultTimeZone: text().notNull().default('Africa/Lagos'),
  ...timestamps(),
});

export const staffRoles = pgTable(
  'staff_roles',
  {
    id: id(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: staffRoleEnum().notNull(),
    grantedBy: text().references(() => user.id),
    grantedAt: createdAt(),
    revokedAt: tstz(),
    revokedBy: text().references(() => user.id),
    reason: text(),
  },
  (t) => [
    index('staff_roles_user_idx').on(t.userId),
    uniqueIndex('staff_roles_active_unique')
      .on(t.userId, t.role)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const partnerProfiles = pgTable(
  'partner_profiles',
  {
    id: id(),
    userId: text()
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text().references(() => organization.id),
    partnerType: partnerTypeEnum().notNull(),
    displayName: text().notNull(),
    credentials: jsonObject<
      Array<{
        title: string;
        issuer?: string;
        reference?: string;
        expiresAt?: string;
        verifiedAt?: string;
        checkedBy?: string;
      }>
    >(),
    coverageStateIds: uuid().array(),
    availabilityStatus: text().notNull().default('unknown'),
    conflictDisclosures: text(),
    verificationStatus: verificationStatusEnum().notNull().default('unverified'),
    verifiedAt: tstz(),
    verifiedBy: text().references(() => user.id),
    verificationExpiresAt: tstz(),
    verificationScope: text(),
    ratingAverage: integer(),
    ...timestamps(),
  },
  (t) => [index('partner_profiles_type_idx').on(t.partnerType)],
);

/**
 * Explicit resource-level access grants (household members, advisers, tenants,
 * assigned partners). Authorisation checks consult these in addition to
 * organisation membership and staff roles.
 */
export const resourceGrants = pgTable(
  'resource_grants',
  {
    id: id(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text().references(() => organization.id),
    resourceType: text().notNull(),
    resourceId: uuid().notNull(),
    level: grantLevelEnum().notNull().default('view'),
    grantedBy: text().references(() => user.id),
    reason: text(),
    expiresAt: tstz(),
    revokedAt: tstz(),
    revokedBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('resource_grants_lookup_idx').on(t.userId, t.resourceType, t.resourceId),
    index('resource_grants_resource_idx').on(t.resourceType, t.resourceId),
  ],
);

export const consents = pgTable(
  'consents',
  {
    id: id(),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    subjectEmail: text(),
    purpose: text().notNull(),
    granted: boolean().notNull(),
    policyVersion: text().notNull(),
    source: text().notNull(),
    ipHash: text(),
    recordedAt: createdAt(),
  },
  (t) => [index('consents_user_idx').on(t.userId, t.purpose)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text().notNull(),
    requesterId: text().notNull(),
    endpoint: text().notNull(),
    requestHash: text().notNull(),
    responseStatus: integer(),
    responseBody: jsonb(),
    lockedAt: tstz(),
    completedAt: tstz(),
    expiresAt: tstz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.requesterId, t.endpoint, t.key] }),
    index('idempotency_keys_expiry_idx').on(t.expiresAt),
  ],
);

export const impersonationSessions = pgTable(
  'impersonation_sessions',
  {
    id: id(),
    adminUserId: text()
      .notNull()
      .references(() => user.id),
    targetUserId: text()
      .notNull()
      .references(() => user.id),
    reason: text().notNull(),
    sessionId: text(),
    startedAt: createdAt(),
    expiresAt: tstz().notNull(),
    endedAt: tstz(),
  },
  (t) => [index('impersonation_admin_idx').on(t.adminUserId)],
);

export const setupTokens = pgTable('setup_tokens', {
  id: id(),
  purpose: text().notNull(),
  tokenHash: text().notNull().unique(),
  email: text().notNull(),
  payload: jsonb(),
  expiresAt: tstz().notNull(),
  usedAt: timestamp({ withTimezone: true, mode: 'date' }),
  createdAt: createdAt(),
});
