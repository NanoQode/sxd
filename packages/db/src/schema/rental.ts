import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currency,
  id,
  jsonObject,
  kobo,
  koboNotNull,
  koboZero,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';
import { markets } from './geography';
import { properties, units } from './property';

export const leaseKindEnum = pgEnum('lease_kind', [
  'residential_annual',
  'residential_monthly',
  'commercial',
  'student_academic',
  'short_stay_management',
]);

export const leaseStatusEnum = pgEnum('lease_status', [
  'draft',
  'pending_signature',
  'active',
  'expiring',
  'ended',
  'terminated',
]);

export const rentPeriodEnum = pgEnum('rent_period', ['annual', 'quarterly', 'monthly', 'term']);

export const managementFeeBasisEnum = pgEnum('management_fee_basis', [
  'percentage_of_collected',
  'fixed_monthly',
  'none',
]);

export const leasePartyRoleEnum = pgEnum('lease_party_role', [
  'tenant',
  'guarantor',
  'occupant',
  'owner_representative',
]);

export const partyAccessStatusEnum = pgEnum('party_access_status', [
  'not_invited',
  'invited',
  'active',
  'revoked',
  'expired',
]);

export const rentScheduleStatusEnum = pgEnum('rent_schedule_status', [
  'scheduled',
  'invoiced',
  'partially_paid',
  'paid',
  'overdue',
  'waived',
]);

export const rentChargeKindEnum = pgEnum('rent_charge_kind', [
  'rent',
  'service_charge',
  'late_fee',
  'utility',
  'deposit',
  'other',
]);

export const workOrderStatusEnum = pgEnum('work_order_status', [
  'requested',
  'triaged',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'approved',
  'completed',
  'verified',
  'closed',
  'rejected',
  'cancelled',
]);

export const workOrderPriorityEnum = pgEnum('work_order_priority', [
  'low',
  'normal',
  'high',
  'urgent',
]);

export const ownerStatementStatusEnum = pgEnum('owner_statement_status', [
  'draft',
  'reconciled',
  'issued',
]);

export const stayBookingStatusEnum = pgEnum('stay_booking_status', [
  'requested',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
]);

export const estates = pgTable(
  'estates',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    name: text().notNull(),
    marketId: uuid().references(() => markets.id),
    serviceChargePolicy: jsonb(),
    visitorPolicyWebhookUrl: text(),
    ledgerSegment: text().notNull(),
    ...timestamps(),
  },
  (t) => [index('estates_org_idx').on(t.organizationId)],
);

export const leases = pgTable(
  'leases',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    unitId: uuid().references(() => units.id),
    kind: leaseKindEnum().notNull(),
    status: leaseStatusEnum().notNull().default('draft'),
    startDate: date({ mode: 'string' }).notNull(),
    endDate: date({ mode: 'string' }),
    rentAmountKobo: koboNotNull(),
    rentPeriod: rentPeriodEnum().notNull(),
    currency: currency(),
    depositKobo: koboZero(),
    managementFeeBasis: managementFeeBasisEnum().notNull().default('none'),
    managementFeeBps: integer(),
    managementFeeFixedKobo: kobo(),
    termsFileId: uuid(),
    academicPeriod: text(),
    noticePeriodDays: integer(),
    terminatedAt: tstz(),
    terminationReason: text(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('leases_org_idx').on(t.organizationId, t.status),
    index('leases_property_idx').on(t.propertyId),
  ],
);

export const leaseParties = pgTable(
  'lease_parties',
  {
    id: id(),
    leaseId: uuid()
      .notNull()
      .references(() => leases.id),
    userId: text().references(() => user.id),
    role: leasePartyRoleEnum().notNull(),
    name: text().notNull(),
    email: text(),
    phoneE164: text(),
    invitationTokenHash: text(),
    accessStatus: partyAccessStatusEnum().notNull().default('not_invited'),
    invitedAt: tstz(),
    invitationExpiresAt: tstz(),
    acceptedAt: tstz(),
    revokedAt: tstz(),
    revokedBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('lease_parties_lease_idx').on(t.leaseId),
    index('lease_parties_user_idx').on(t.userId),
  ],
);

export const rentSchedules = pgTable(
  'rent_schedules',
  {
    id: id(),
    leaseId: uuid()
      .notNull()
      .references(() => leases.id),
    periodStart: date({ mode: 'string' }).notNull(),
    periodEnd: date({ mode: 'string' }).notNull(),
    dueDate: date({ mode: 'string' }).notNull(),
    amountKobo: koboNotNull(),
    status: rentScheduleStatusEnum().notNull().default('scheduled'),
    invoiceId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rent_schedules_unique').on(t.leaseId, t.periodStart)],
);

export const rentCharges = pgTable(
  'rent_charges',
  {
    id: id(),
    leaseId: uuid()
      .notNull()
      .references(() => leases.id),
    scheduleId: uuid().references(() => rentSchedules.id),
    kind: rentChargeKindEnum().notNull(),
    description: text().notNull(),
    amountKobo: koboNotNull(),
    chargedAt: date({ mode: 'string' }).notNull(),
    invoiceId: uuid(),
    estateId: uuid().references(() => estates.id),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('rent_charges_lease_idx').on(t.leaseId)],
);

export const rentAllocations = pgTable(
  'rent_allocations',
  {
    id: id(),
    leaseId: uuid()
      .notNull()
      .references(() => leases.id),
    rentChargeId: uuid()
      .notNull()
      .references(() => rentCharges.id),
    allocationId: uuid(),
    amountKobo: koboNotNull(),
    allocatedAt: createdAt(),
    allocatedBy: text().references(() => user.id),
    journalId: uuid(),
  },
  (t) => [index('rent_allocations_lease_idx').on(t.leaseId)],
);

export const assets = pgTable(
  'assets',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    estateId: uuid().references(() => estates.id),
    name: text().notNull(),
    category: text().notNull(),
    serialNumber: text(),
    installedAt: date({ mode: 'string' }),
    condition: text().notNull().default('unknown'),
    nextServiceAt: date({ mode: 'string' }),
    serviceIntervalDays: integer(),
    notes: text(),
    ...timestamps(),
  },
  (t) => [index('assets_property_idx').on(t.propertyId)],
);

export const warranties = pgTable(
  'warranties',
  {
    id: id(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    reference: text(),
    startsAt: date({ mode: 'string' }),
    expiresAt: date({ mode: 'string' }).notNull(),
    documentFileId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index('warranties_asset_idx').on(t.assetId)],
);

export const workOrders = pgTable(
  'work_orders',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    unitId: uuid().references(() => units.id),
    leaseId: uuid().references(() => leases.id),
    assetId: uuid().references(() => assets.id),
    estateId: uuid().references(() => estates.id),
    reportedByUserId: text().references(() => user.id),
    title: text().notNull(),
    description: text(),
    category: text().notNull().default('other'),
    priority: workOrderPriorityEnum().notNull().default('normal'),
    status: workOrderStatusEnum().notNull().default('requested'),
    assigneeUserId: text().references(() => user.id),
    estimateKobo: kobo(),
    approvedAmountKobo: kobo(),
    approvedBy: text().references(() => user.id),
    approvedAt: tstz(),
    actualCostKobo: kobo(),
    expenseJournalId: uuid(),
    slaDueAt: tstz(),
    recurring: jsonb(),
    completedAt: tstz(),
    verifiedBy: text().references(() => user.id),
    verifiedAt: tstz(),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('work_orders_org_idx').on(t.organizationId, t.status),
    index('work_orders_property_idx').on(t.propertyId),
    index('work_orders_assignee_idx').on(t.assigneeUserId, t.status),
  ],
);

export const ownerStatements = pgTable(
  'owner_statements',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid().references(() => properties.id),
    estateId: uuid().references(() => estates.id),
    periodStart: date({ mode: 'string' }).notNull(),
    periodEnd: date({ mode: 'string' }).notNull(),
    status: ownerStatementStatusEnum().notNull().default('draft'),
    totals: jsonObject<{
      collectedKobo: string;
      feesKobo: string;
      expensesKobo: string;
      netKobo: string;
      arrearsKobo: string;
      openObligations: Array<{ description: string; amountKobo: string }>;
    }>(),
    lines: jsonb(),
    fileId: uuid(),
    generatedAt: createdAt(),
    reconciledBy: text().references(() => user.id),
    reconciledAt: tstz(),
    issuedAt: tstz(),
  },
  (t) => [index('owner_statements_org_idx').on(t.organizationId, t.periodStart)],
);

export const stayBookings = pgTable(
  'stay_bookings',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id),
    unitId: uuid().references(() => units.id),
    guestName: text().notNull(),
    guestContact: jsonb(),
    checkIn: date({ mode: 'string' }).notNull(),
    checkOut: date({ mode: 'string' }).notNull(),
    nights: integer().notNull(),
    nightlyRateKobo: koboNotNull(),
    platformFeeKobo: koboZero(),
    cleaningKobo: koboZero(),
    status: stayBookingStatusEnum().notNull().default('requested'),
    channel: text(),
    notes: text(),
    ...timestamps(),
  },
  (t) => [index('stay_bookings_property_idx').on(t.propertyId, t.checkIn)],
);
