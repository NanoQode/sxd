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
  id,
  jsonObject,
  kobo,
  koboNotNull,
  timestamps,
  tstz,
  version,
} from './_common';
import { organization, user } from './auth';
import { serviceRequests } from './crm';
import { markets } from './geography';
import { materialEnum, supplyFacilities } from './intelligence';
import { budgetVersions, projects } from './project';

export const tenderStatusEnum = pgEnum('tender_status', [
  'draft',
  'published',
  'clarifications',
  'closed',
  'evaluating',
  'awarded',
  'cancelled',
]);

export const tenderInvitationStatusEnum = pgEnum('tender_invitation_status', [
  'invited',
  'viewed',
  'declined',
  'submitted',
]);

export const bidStatusEnum = pgEnum('bid_status', [
  'draft',
  'submitted',
  'withdrawn',
  'disqualified',
  'evaluated',
  'awarded',
  'unsuccessful',
]);

export const awardStatusEnum = pgEnum('award_status', [
  'decided',
  'published',
  'accepted',
  'declined',
  'rescinded',
]);

export const rfqStatusEnum = pgEnum('rfq_status', [
  'draft',
  'sent',
  'closed',
  'awarded',
  'cancelled',
]);

export const rfqResponseStatusEnum = pgEnum('rfq_response_status', [
  'draft',
  'submitted',
  'withdrawn',
  'selected',
  'rejected',
]);

export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'draft',
  'issued',
  'acknowledged',
  'partially_delivered',
  'delivered',
  'closed',
  'cancelled',
]);

export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'received',
  'disputed',
  'accepted',
]);

export const discrepancyStatusEnum = pgEnum('discrepancy_status', [
  'open',
  'supplier_notified',
  'resolved',
  'credited',
  'returned',
]);

export const tenders = pgTable(
  'tenders',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    serviceRequestId: uuid().references(() => serviceRequests.id),
    reference: text().notNull().unique(),
    title: text().notNull(),
    descriptionMarkdown: text(),
    scopeFileIds: jsonObject<string[]>(),
    boqBudgetVersionId: uuid().references(() => budgetVersions.id),
    status: tenderStatusEnum().notNull().default('draft'),
    sealed: boolean().notNull().default(true),
    releaseAt: tstz(),
    siteVisitAt: tstz(),
    questionCutoffAt: tstz(),
    answersPublishedAt: tstz(),
    /** Authoritative server-side submission deadline (UTC). */
    submissionDeadlineAt: tstz(),
    evaluationCompleteAt: tstz(),
    awardTargetAt: tstz(),
    displayTimeZone: text().notNull().default('Africa/Lagos'),
    currentRevision: integer().notNull().default(1),
    evaluationWeights: jsonObject<Record<string, number>>(),
    partnerDisclosure: text(),
    closedAt: tstz(),
    cancelledReason: text(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('tenders_org_idx').on(t.organizationId, t.status),
    index('tenders_deadline_idx').on(t.submissionDeadlineAt),
  ],
);

export const tenderRevisions = pgTable(
  'tender_revisions',
  {
    id: id(),
    tenderId: uuid()
      .notNull()
      .references(() => tenders.id),
    revision: integer().notNull(),
    changes: jsonb().notNull(),
    addendumMarkdown: text(),
    deadlineExtendedTo: tstz(),
    reason: text(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tender_revisions_unique').on(t.tenderId, t.revision)],
);

export const tenderInvitations = pgTable(
  'tender_invitations',
  {
    id: id(),
    tenderId: uuid()
      .notNull()
      .references(() => tenders.id),
    partnerUserId: text()
      .notNull()
      .references(() => user.id),
    status: tenderInvitationStatusEnum().notNull().default('invited'),
    invitedBy: text().references(() => user.id),
    invitedAt: createdAt(),
    viewedAt: tstz(),
    respondedAt: tstz(),
  },
  (t) => [
    uniqueIndex('tender_invitations_unique').on(t.tenderId, t.partnerUserId),
    index('tender_invitations_partner_idx').on(t.partnerUserId),
  ],
);

export const tenderQuestions = pgTable(
  'tender_questions',
  {
    id: id(),
    tenderId: uuid()
      .notNull()
      .references(() => tenders.id),
    askedByUserId: text()
      .notNull()
      .references(() => user.id),
    question: text().notNull(),
    askedAt: createdAt(),
    answer: text(),
    answeredBy: text().references(() => user.id),
    answeredAt: tstz(),
    published: boolean().notNull().default(false),
  },
  (t) => [index('tender_questions_tender_idx').on(t.tenderId)],
);

export const bids = pgTable(
  'bids',
  {
    id: id(),
    tenderId: uuid()
      .notNull()
      .references(() => tenders.id),
    partnerUserId: text()
      .notNull()
      .references(() => user.id),
    status: bidStatusEnum().notNull().default('draft'),
    currentVersion: integer().notNull().default(0),
    submittedAt: tstz(),
    withdrawnAt: tstz(),
    /** Sealed bids stay closed until the tender closes unless an audited procedure opens them. */
    openedAt: tstz(),
    openedBy: text().references(() => user.id),
    openReason: text(),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('bids_unique').on(t.tenderId, t.partnerUserId),
    index('bids_partner_idx').on(t.partnerUserId),
  ],
);

export const bidRevisions = pgTable(
  'bid_revisions',
  {
    id: id(),
    bidId: uuid()
      .notNull()
      .references(() => bids.id),
    version: integer().notNull(),
    amountKobo: koboNotNull(),
    currency: currency(),
    lineItems: jsonb(),
    durationDays: integer(),
    qualifications: jsonb(),
    attachmentFileIds: jsonObject<string[]>(),
    submittedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bid_revisions_unique').on(t.bidId, t.version)],
);

export const bidEvaluations = pgTable(
  'bid_evaluations',
  {
    id: id(),
    tenderId: uuid()
      .notNull()
      .references(() => tenders.id),
    bidId: uuid()
      .notNull()
      .references(() => bids.id),
    evaluatorUserId: text()
      .notNull()
      .references(() => user.id),
    scores: jsonObject<Record<string, number>>().notNull(),
    weightedScore: numeric({ precision: 8, scale: 4 }),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bid_evaluations_unique').on(t.bidId, t.evaluatorUserId)],
);

export const awards = pgTable('awards', {
  id: id(),
  tenderId: uuid()
    .notNull()
    .unique()
    .references(() => tenders.id),
  bidId: uuid()
    .notNull()
    .references(() => bids.id),
  status: awardStatusEnum().notNull().default('decided'),
  contractValueKobo: kobo(),
  decidedBy: text().references(() => user.id),
  decidedAt: createdAt(),
  publishedAt: tstz(),
  publishedBy: text().references(() => user.id),
  notes: text(),
  respondedAt: tstz(),
});

export const bidAccessLog = pgTable(
  'bid_access_log',
  {
    id: id(),
    bidId: uuid()
      .notNull()
      .references(() => bids.id),
    userId: text()
      .notNull()
      .references(() => user.id),
    action: text().notNull(),
    reason: text(),
    createdAt: createdAt(),
  },
  (t) => [index('bid_access_log_bid_idx').on(t.bidId)],
);

export const rfqs = pgTable(
  'rfqs',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    reference: text().notNull().unique(),
    title: text().notNull(),
    status: rfqStatusEnum().notNull().default('draft'),
    deadlineAt: tstz(),
    deliveryMarketId: uuid().references(() => markets.id),
    deliveryAddress: jsonb(),
    notes: text(),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('rfqs_org_idx').on(t.organizationId, t.status)],
);

export const rfqItems = pgTable(
  'rfq_items',
  {
    id: id(),
    rfqId: uuid()
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    material: materialEnum().notNull(),
    specification: text().notNull(),
    unit: text().notNull(),
    quantity: numeric({ precision: 14, scale: 3 }).notNull(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [index('rfq_items_rfq_idx').on(t.rfqId)],
);

export const rfqResponses = pgTable(
  'rfq_responses',
  {
    id: id(),
    rfqId: uuid()
      .notNull()
      .references(() => rfqs.id),
    supplierFacilityId: uuid().references(() => supplyFacilities.id),
    supplierUserId: text().references(() => user.id),
    supplierName: text(),
    status: rfqResponseStatusEnum().notNull().default('draft'),
    lines: jsonb().notNull(),
    totalDeliveredKobo: kobo(),
    currency: currency(),
    validUntil: tstz(),
    submittedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('rfq_responses_rfq_idx').on(t.rfqId),
    index('rfq_responses_supplier_idx').on(t.supplierUserId),
  ],
);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    organizationId: text()
      .notNull()
      .references(() => organization.id),
    projectId: uuid().references(() => projects.id),
    rfqId: uuid().references(() => rfqs.id),
    responseId: uuid().references(() => rfqResponses.id),
    number: text().notNull().unique(),
    status: purchaseOrderStatusEnum().notNull().default('draft'),
    supplierUserId: text().references(() => user.id),
    supplierName: text(),
    supplierRef: text(),
    lines: jsonb().notNull(),
    totalKobo: koboNotNull(),
    currency: currency(),
    issuedAt: tstz(),
    expectedDeliveryAt: tstz(),
    createdBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [index('purchase_orders_org_idx').on(t.organizationId, t.status)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    purchaseOrderId: uuid()
      .notNull()
      .references(() => purchaseOrders.id),
    deliveredAt: tstz(),
    receivedByUserId: text().references(() => user.id),
    lines: jsonb().notNull(),
    evidenceFileIds: jsonObject<string[]>(),
    status: deliveryStatusEnum().notNull().default('pending'),
    note: text(),
    ...timestamps(),
  },
  (t) => [index('deliveries_po_idx').on(t.purchaseOrderId)],
);

export const discrepancies = pgTable(
  'discrepancies',
  {
    id: id(),
    deliveryId: uuid()
      .notNull()
      .references(() => deliveries.id),
    kind: text().notNull(),
    description: text().notNull(),
    quantity: numeric({ precision: 14, scale: 3 }),
    status: discrepancyStatusEnum().notNull().default('open'),
    resolution: text(),
    createdBy: text().references(() => user.id),
    resolvedAt: tstz(),
    ...timestamps(),
  },
  (t) => [index('discrepancies_delivery_idx').on(t.deliveryId)],
);
