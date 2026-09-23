import { z } from 'zod';
import {
  cursorPaginationQuerySchema,
  dateOnlySchema,
  emailSchema,
  expectedVersionSchema,
  isoDateTimeSchema,
  phoneE164Schema,
  uuidSchema,
} from './common';
import { nonNegativeKoboStringSchema as koboStringSchema } from './projects';

/**
 * Property management: leases, parties, rent schedules and charges, the
 * tenant portal, maintenance work orders, the asset register, owner
 * statements and payouts, estates and short-stay bookings. Money is integer
 * kobo as decimal strings; dates without time are `YYYY-MM-DD`.
 */

/* ---------------------------------------------------------------------- */
/* Leases                                                                  */
/* ---------------------------------------------------------------------- */

export const leaseKindSchema = z.enum([
  'residential_annual',
  'residential_monthly',
  'commercial',
  'student_academic',
  'short_stay_management',
]);
export type LeaseKind = z.infer<typeof leaseKindSchema>;

export const leaseStatusSchema = z.enum([
  'draft',
  'pending_signature',
  'active',
  'expiring',
  'ended',
  'terminated',
]);
export type LeaseStatus = z.infer<typeof leaseStatusSchema>;

export const rentPeriodSchema = z.enum(['annual', 'quarterly', 'monthly', 'term']);
export type RentPeriodDto = z.infer<typeof rentPeriodSchema>;

export const managementFeeBasisSchema = z.enum(['percentage_of_collected', 'fixed_monthly', 'none']);

export const academicTermSchema = z.object({
  label: z.string().trim().min(1).max(120),
  start: dateOnlySchema,
  end: dateOnlySchema,
  amountKobo: koboStringSchema.optional(),
});
export type AcademicTermDto = z.infer<typeof academicTermSchema>;

export const guarantorSchema = z.object({
  name: z.string().trim().min(2).max(160),
  relationship: z.string().trim().max(80).optional(),
  email: emailSchema.optional(),
  phoneE164: phoneE164Schema.optional(),
  address: z.string().trim().max(400).optional(),
  /** File id of the signed guarantor undertaking, when uploaded. */
  undertakingFileId: uuidSchema.optional(),
});
export type GuarantorDto = z.infer<typeof guarantorSchema>;

export const inventoryItemSchema = z.object({
  room: z.string().trim().min(1).max(80),
  item: z.string().trim().min(1).max(160),
  condition: z.enum(['new', 'good', 'fair', 'poor', 'damaged']),
  note: z.string().trim().max(500).optional(),
  photoFileIds: z.array(uuidSchema).max(20).default([]),
});

export const moveInInventorySchema = z.object({
  recordedAt: isoDateTimeSchema,
  recordedBy: z.string().max(64).optional(),
  items: z.array(inventoryItemSchema).min(1).max(500),
  tenantAcknowledgedAt: isoDateTimeSchema.optional(),
});
export type MoveInInventoryDto = z.infer<typeof moveInInventorySchema>;

/** Optional lease terms stored beside the core columns (rental placement, student housing). */
export const leaseTermsSchema = z.object({
  /** Service charge per rent period, invoiced with the rent. */
  serviceChargeKobo: koboStringSchema.optional(),
  /** Days before a period start on which the rent is due (0 = on the day). */
  dueLeadDays: z.number().int().min(0).max(365).default(0),
  /** Prorate a partial first or last period by days (default true). */
  prorate: z.boolean().default(true),
  academicTerms: z.array(academicTermSchema).max(12).optional(),
  guarantor: guarantorSchema.optional(),
  moveInInventory: moveInInventorySchema.optional(),
});
export type LeaseTermsDto = z.infer<typeof leaseTermsSchema>;

export const leaseCreateSchema = z.object({
  propertyId: uuidSchema,
  unitId: uuidSchema.nullable().optional(),
  kind: leaseKindSchema,
  startDate: dateOnlySchema,
  endDate: dateOnlySchema.nullable().optional(),
  rentAmountKobo: koboStringSchema,
  rentPeriod: rentPeriodSchema,
  currency: z.string().length(3).default('NGN'),
  depositKobo: koboStringSchema.default('0'),
  managementFeeBasis: managementFeeBasisSchema.default('none'),
  managementFeeBps: z.number().int().min(0).max(10_000).nullable().optional(),
  managementFeeFixedKobo: koboStringSchema.nullable().optional(),
  termsFileId: uuidSchema.nullable().optional(),
  academicPeriod: z.string().trim().max(80).nullable().optional(),
  noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
  terms: leaseTermsSchema.partial().optional(),
});
export type LeaseCreate = z.infer<typeof leaseCreateSchema>;

export const leaseUpdateSchema = leaseCreateSchema
  .omit({ propertyId: true })
  .partial()
  .extend({ expectedVersion: expectedVersionSchema })
  .refine((v) => Object.keys(v).length > 1, 'nothing to update');
export type LeaseUpdate = z.infer<typeof leaseUpdateSchema>;

export const leaseTransitionSchema = z.object({
  to: z.enum(['pending_signature', 'active', 'ended']),
  expectedVersion: expectedVersionSchema,
});
export type LeaseTransition = z.infer<typeof leaseTransitionSchema>;

export const leaseTerminateSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
  terminatedOn: dateOnlySchema.optional(),
  expectedVersion: expectedVersionSchema,
});
export type LeaseTerminate = z.infer<typeof leaseTerminateSchema>;

export const leaseRenewSchema = z.object({
  startDate: dateOnlySchema,
  endDate: dateOnlySchema.nullable().optional(),
  rentAmountKobo: koboStringSchema.optional(),
  expectedVersion: expectedVersionSchema,
});
export type LeaseRenew = z.infer<typeof leaseRenewSchema>;

export const leaseListQuerySchema = cursorPaginationQuerySchema.extend({
  propertyId: uuidSchema.optional(),
  status: leaseStatusSchema.optional(),
  organizationId: z.string().min(1).max(64).optional(),
});
export type LeaseListQuery = z.infer<typeof leaseListQuerySchema>;

export const leasePartyRoleSchema = z.enum(['tenant', 'guarantor', 'occupant', 'owner_representative']);
export const partyAccessStatusSchema = z.enum(['not_invited', 'invited', 'active', 'revoked', 'expired']);

export const leasePartyDtoSchema = z.object({
  id: uuidSchema,
  leaseId: uuidSchema,
  userId: z.string().nullable(),
  role: leasePartyRoleSchema,
  name: z.string(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  accessStatus: partyAccessStatusSchema,
  invitedAt: isoDateTimeSchema.nullable(),
  invitationExpiresAt: isoDateTimeSchema.nullable(),
  acceptedAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type LeasePartyDto = z.infer<typeof leasePartyDtoSchema>;

export const leaseDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  propertyId: uuidSchema,
  unitId: uuidSchema.nullable(),
  kind: leaseKindSchema,
  status: leaseStatusSchema,
  startDate: dateOnlySchema,
  endDate: dateOnlySchema.nullable(),
  rentAmountKobo: koboStringSchema,
  rentPeriod: rentPeriodSchema,
  currency: z.string(),
  depositKobo: koboStringSchema,
  managementFeeBasis: managementFeeBasisSchema,
  managementFeeBps: z.number().int().nullable(),
  managementFeeFixedKobo: koboStringSchema.nullable(),
  termsFileId: uuidSchema.nullable(),
  academicPeriod: z.string().nullable(),
  noticePeriodDays: z.number().int().nullable(),
  terminatedAt: isoDateTimeSchema.nullable(),
  terminationReason: z.string().nullable(),
  terms: leaseTermsSchema.partial().nullable(),
  parties: z.array(leasePartyDtoSchema),
  createdBy: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeaseDto = z.infer<typeof leaseDtoSchema>;

export const leasePartyInviteSchema = z.object({
  role: leasePartyRoleSchema.default('tenant'),
  name: z.string().trim().min(2).max(160),
  email: emailSchema,
  phoneE164: phoneE164Schema.optional(),
  /** Invitation validity in days (1–30, default 7). */
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export type LeasePartyInvite = z.infer<typeof leasePartyInviteSchema>;

export const leasePartyRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export const tenantInvitationAcceptSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'invitation token'),
});
export type TenantInvitationAccept = z.infer<typeof tenantInvitationAcceptSchema>;

export const leaseNoticeSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(4000),
});
export type LeaseNotice = z.infer<typeof leaseNoticeSchema>;

/* ---------------------------------------------------------------------- */
/* Rent schedules and charges                                              */
/* ---------------------------------------------------------------------- */

export const rentScheduleStatusSchema = z.enum([
  'scheduled',
  'invoiced',
  'partially_paid',
  'paid',
  'overdue',
  'waived',
]);

export const rentScheduleDtoSchema = z.object({
  id: uuidSchema,
  leaseId: uuidSchema,
  periodStart: dateOnlySchema,
  periodEnd: dateOnlySchema,
  dueDate: dateOnlySchema,
  amountKobo: koboStringSchema,
  status: rentScheduleStatusSchema,
  invoiceId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type RentScheduleDto = z.infer<typeof rentScheduleDtoSchema>;

export const rentChargeKindSchema = z.enum([
  'rent',
  'service_charge',
  'late_fee',
  'utility',
  'deposit',
  'other',
]);

export const rentChargeDtoSchema = z.object({
  id: uuidSchema,
  leaseId: uuidSchema,
  scheduleId: uuidSchema.nullable(),
  kind: rentChargeKindSchema,
  description: z.string(),
  amountKobo: koboStringSchema,
  chargedAt: dateOnlySchema,
  invoiceId: uuidSchema.nullable(),
  estateId: uuidSchema.nullable(),
  /** Allocated so far (settled money only). */
  paidKobo: koboStringSchema,
  outstandingKobo: koboStringSchema,
  createdAt: isoDateTimeSchema,
});
export type RentChargeDto = z.infer<typeof rentChargeDtoSchema>;

export const rentChargeCreateSchema = z.object({
  kind: rentChargeKindSchema.exclude(['rent']),
  description: z.string().trim().min(1).max(500),
  amountKobo: koboStringSchema.refine((v) => BigInt(v) > 0n, 'amount must be positive'),
  chargedAt: dateOnlySchema.optional(),
});
export type RentChargeCreate = z.infer<typeof rentChargeCreateSchema>;

export const arrearsBucketSchema = z.enum([
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_over_90',
]);

export const arrearsDtoSchema = z.object({
  asOf: dateOnlySchema,
  buckets: z.record(arrearsBucketSchema, koboStringSchema),
  totalOutstandingKobo: koboStringSchema,
  items: z.array(
    z.object({
      chargeId: uuidSchema,
      outstandingKobo: koboStringSchema,
      daysOverdue: z.number().int(),
      bucket: arrearsBucketSchema,
    }),
  ),
});
export type ArrearsDto = z.infer<typeof arrearsDtoSchema>;

export const leaseBalanceDtoSchema = z.object({
  leaseId: uuidSchema,
  currency: z.string(),
  chargedKobo: koboStringSchema,
  paidKobo: koboStringSchema,
  outstandingKobo: koboStringSchema,
  depositHeldKobo: koboStringSchema,
  nextDue: z
    .object({ dueDate: dateOnlySchema, amountKobo: koboStringSchema, invoiceId: uuidSchema.nullable() })
    .nullable(),
  arrears: arrearsDtoSchema,
});
export type LeaseBalanceDto = z.infer<typeof leaseBalanceDtoSchema>;

export const rentInvoicingRunDtoSchema = z.object({
  invoiced: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invoiceIds: z.array(uuidSchema),
});

/* ---------------------------------------------------------------------- */
/* Tenant portal                                                           */
/* ---------------------------------------------------------------------- */

export const tenantReceiptDtoSchema = z.object({
  id: uuidSchema,
  number: z.string(),
  invoiceId: uuidSchema,
  invoiceNumber: z.string(),
  amountKobo: koboStringSchema,
  issuedAt: isoDateTimeSchema,
});
export type TenantReceiptDto = z.infer<typeof tenantReceiptDtoSchema>;

export const tenantNoticeDtoSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  body: z.string().nullable(),
  leaseId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  readAt: isoDateTimeSchema.nullable(),
});
export type TenantNoticeDto = z.infer<typeof tenantNoticeDtoSchema>;

export const tenantAppointmentDtoSchema = z.object({
  id: uuidSchema,
  kind: z.string(),
  status: z.string(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  topic: z.string().nullable(),
  locationNote: z.string().nullable(),
});

export const tenantLeaseSummarySchema = z.object({
  lease: leaseDtoSchema.omit({ parties: true, managementFeeBasis: true, managementFeeBps: true, managementFeeFixedKobo: true }),
  property: z.object({ id: uuidSchema, name: z.string(), address: z.record(z.string(), z.unknown()).nullable() }),
  unit: z.object({ id: uuidSchema, label: z.string() }).nullable(),
  myRole: leasePartyRoleSchema,
});
export type TenantLeaseSummary = z.infer<typeof tenantLeaseSummarySchema>;

/* ---------------------------------------------------------------------- */
/* Maintenance                                                             */
/* ---------------------------------------------------------------------- */

export const workOrderStatusSchema = z.enum([
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
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

export const workOrderPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const workOrderCreateSchema = z.object({
  propertyId: uuidSchema,
  unitId: uuidSchema.nullable().optional(),
  leaseId: uuidSchema.nullable().optional(),
  assetId: uuidSchema.nullable().optional(),
  estateId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  category: z.string().trim().min(1).max(60).default('other'),
  priority: workOrderPrioritySchema.default('normal'),
});
export type WorkOrderCreate = z.infer<typeof workOrderCreateSchema>;

export const workOrderTriageSchema = z.object({
  priority: workOrderPrioritySchema.optional(),
  category: z.string().trim().min(1).max(60).optional(),
  estimateKobo: koboStringSchema.nullable().optional(),
  expectedVersion: expectedVersionSchema,
});

export const workOrderAssignSchema = z.object({
  assigneeUserId: z.string().min(1).max(64),
  instructions: z.string().trim().max(4000).nullable().optional(),
  expectedVersion: expectedVersionSchema,
});

export const workOrderEstimateSchema = z.object({
  estimateKobo: koboStringSchema.refine((v) => BigInt(v) > 0n, 'estimate must be positive'),
  note: z.string().trim().max(2000).nullable().optional(),
  expectedVersion: expectedVersionSchema,
});

export const workOrderApproveSchema = z.object({
  approvedAmountKobo: koboStringSchema.refine((v) => BigInt(v) > 0n, 'amount must be positive'),
  expectedVersion: expectedVersionSchema,
});

export const workOrderRejectSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
  expectedVersion: expectedVersionSchema,
});

export const workOrderEvidenceSchema = z.object({
  fileIds: z.array(uuidSchema).min(1).max(50),
  caption: z.string().trim().max(500).nullable().optional(),
  capturedAt: isoDateTimeSchema.nullable().optional(),
});
export type WorkOrderEvidence = z.infer<typeof workOrderEvidenceSchema>;

export const workOrderCompleteSchema = z.object({
  actualCostKobo: koboStringSchema.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  expectedVersion: expectedVersionSchema,
});

export const workOrderVerifySchema = z.object({
  /** Cost to record as a recoverable expense; defaults to the actual cost, then the approved amount. */
  costKobo: koboStringSchema.nullable().optional(),
  expectedVersion: expectedVersionSchema,
});

export const workOrderSimpleTransitionSchema = z.object({ expectedVersion: expectedVersionSchema });

export const workOrderListQuerySchema = cursorPaginationQuerySchema.extend({
  propertyId: uuidSchema.optional(),
  leaseId: uuidSchema.optional(),
  estateId: uuidSchema.optional(),
  status: workOrderStatusSchema.optional(),
  organizationId: z.string().min(1).max(64).optional(),
  breachedOnly: z.coerce.boolean().optional(),
});
export type WorkOrderListQuery = z.infer<typeof workOrderListQuerySchema>;

export const workOrderEvidenceDtoSchema = z.object({
  id: uuidSchema,
  fileId: uuidSchema,
  kind: z.string(),
  caption: z.string().nullable(),
  capturedAt: isoDateTimeSchema.nullable(),
  uploaderUserId: z.string(),
  receivedAt: isoDateTimeSchema,
});

export const workOrderDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  propertyId: uuidSchema,
  unitId: uuidSchema.nullable(),
  leaseId: uuidSchema.nullable(),
  assetId: uuidSchema.nullable(),
  estateId: uuidSchema.nullable(),
  reportedByUserId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  priority: workOrderPrioritySchema,
  status: workOrderStatusSchema,
  assigneeUserId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  estimateKobo: koboStringSchema.nullable(),
  approvedAmountKobo: koboStringSchema.nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  actualCostKobo: koboStringSchema.nullable(),
  expenseJournalId: uuidSchema.nullable(),
  slaDueAt: isoDateTimeSchema.nullable(),
  slaBreached: z.boolean(),
  recurring: z.record(z.string(), z.unknown()).nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  verifiedBy: z.string().nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  evidence: z.array(workOrderEvidenceDtoSchema),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type WorkOrderDto = z.infer<typeof workOrderDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Assets and warranties                                                   */
/* ---------------------------------------------------------------------- */

export const assetCreateSchema = z.object({
  propertyId: uuidSchema,
  estateId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(1).max(60),
  serialNumber: z.string().trim().max(120).nullable().optional(),
  installedAt: dateOnlySchema.nullable().optional(),
  condition: z.enum(['unknown', 'good', 'fair', 'poor', 'failed']).default('unknown'),
  nextServiceAt: dateOnlySchema.nullable().optional(),
  serviceIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = assetCreateSchema
  .omit({ propertyId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

export const warrantyCreateSchema = z.object({
  provider: z.string().trim().min(1).max(160),
  reference: z.string().trim().max(120).nullable().optional(),
  startsAt: dateOnlySchema.nullable().optional(),
  expiresAt: dateOnlySchema,
  documentFileId: uuidSchema.nullable().optional(),
});
export type WarrantyCreate = z.infer<typeof warrantyCreateSchema>;

export const warrantyDtoSchema = z.object({
  id: uuidSchema,
  assetId: uuidSchema,
  provider: z.string(),
  reference: z.string().nullable(),
  startsAt: dateOnlySchema.nullable(),
  expiresAt: dateOnlySchema,
  status: z.enum(['active', 'expiring', 'expired']),
  documentFileId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const assetDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  propertyId: uuidSchema,
  estateId: uuidSchema.nullable(),
  name: z.string(),
  category: z.string(),
  serialNumber: z.string().nullable(),
  installedAt: dateOnlySchema.nullable(),
  condition: z.string(),
  nextServiceAt: dateOnlySchema.nullable(),
  serviceIntervalDays: z.number().int().nullable(),
  notes: z.string().nullable(),
  warranties: z.array(warrantyDtoSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AssetDto = z.infer<typeof assetDtoSchema>;

export const assetListQuerySchema = cursorPaginationQuerySchema.extend({
  propertyId: uuidSchema.optional(),
  estateId: uuidSchema.optional(),
  organizationId: z.string().min(1).max(64).optional(),
  serviceDueBefore: dateOnlySchema.optional(),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

/* ---------------------------------------------------------------------- */
/* Owner statements and payouts                                            */
/* ---------------------------------------------------------------------- */

export const ownerStatementStatusSchema = z.enum(['draft', 'reconciled', 'issued']);

export const ownerStatementGenerateSchema = z.object({
  organizationId: z.string().min(1).max(64).optional(),
  propertyId: uuidSchema.nullable().optional(),
  estateId: uuidSchema.nullable().optional(),
  periodStart: dateOnlySchema,
  periodEnd: dateOnlySchema,
});
export type OwnerStatementGenerate = z.infer<typeof ownerStatementGenerateSchema>;

export const statementLineKindSchema = z.enum([
  'rent_collected',
  'service_charge_collected',
  'management_fee',
  'maintenance_recovery',
  'short_stay_income',
  'short_stay_expense',
  'arrears',
]);

export const statementLineDtoSchema = z.object({
  kind: statementLineKindSchema,
  description: z.string(),
  amountKobo: koboStringSchema,
  leaseId: uuidSchema.nullable().optional(),
  workOrderId: uuidSchema.nullable().optional(),
  allocationId: uuidSchema.nullable().optional(),
  invoiceId: uuidSchema.nullable().optional(),
  stayBookingId: uuidSchema.nullable().optional(),
  feeBps: z.number().int().nullable().optional(),
});
export type StatementLineDto = z.infer<typeof statementLineDtoSchema>;

export const ownerStatementDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  propertyId: uuidSchema.nullable(),
  estateId: uuidSchema.nullable(),
  periodStart: dateOnlySchema,
  periodEnd: dateOnlySchema,
  status: ownerStatementStatusSchema,
  totals: z.object({
    collectedKobo: koboStringSchema,
    feesKobo: koboStringSchema,
    expensesKobo: koboStringSchema,
    netKobo: koboStringSchema,
    arrearsKobo: koboStringSchema,
    openObligations: z.array(z.object({ description: z.string(), amountKobo: koboStringSchema })),
  }),
  lines: z.array(statementLineDtoSchema),
  reconciliation: z
    .object({
      allocationsKobo: koboStringSchema,
      feeJournalKobo: koboStringSchema,
      recoveryJournalKobo: koboStringSchema,
      matches: z.boolean(),
    })
    .nullable(),
  generatedAt: isoDateTimeSchema,
  reconciledBy: z.string().nullable(),
  reconciledAt: isoDateTimeSchema.nullable(),
  issuedAt: isoDateTimeSchema.nullable(),
});
export type OwnerStatementDto = z.infer<typeof ownerStatementDtoSchema>;

export const ownerStatementListQuerySchema = cursorPaginationQuerySchema.extend({
  organizationId: z.string().min(1).max(64).optional(),
  propertyId: uuidSchema.optional(),
  status: ownerStatementStatusSchema.optional(),
});
export type OwnerStatementListQuery = z.infer<typeof ownerStatementListQuerySchema>;

export const payoutStatusSchema = z.enum([
  'proposed',
  'first_approved',
  'approved',
  'submitted',
  'settled',
  'failed',
  'rejected',
]);

export const payoutProposeSchema = z.object({
  ownerStatementId: uuidSchema,
  /** Defaults to the statement's net payable; may be lower (partial distribution), never higher. */
  amountKobo: koboStringSchema.optional(),
  beneficiary: z.object({
    accountName: z.string().trim().min(2).max(160),
    bankName: z.string().trim().min(2).max(120),
    accountNumberMasked: z.string().trim().min(4).max(32),
  }),
});
export type PayoutPropose = z.infer<typeof payoutProposeSchema>;

export const payoutDecisionSchema = z.object({ reason: z.string().trim().max(2000).optional() });

export const payoutSettleSchema = z.object({
  settlementReference: z.string().trim().min(3).max(120),
});

export const payoutDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  kind: z.string(),
  amountKobo: koboStringSchema,
  currency: z.string(),
  status: payoutStatusSchema,
  beneficiary: z.record(z.string(), z.unknown()).nullable(),
  ownerStatementId: uuidSchema.nullable(),
  reconciliationId: uuidSchema.nullable(),
  proposedBy: z.string().nullable(),
  firstApproverId: z.string().nullable(),
  firstApprovedAt: isoDateTimeSchema.nullable(),
  secondApproverId: z.string().nullable(),
  secondApprovedAt: isoDateTimeSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  settledAt: isoDateTimeSchema.nullable(),
  failureReason: z.string().nullable(),
  journalId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PayoutDto = z.infer<typeof payoutDtoSchema>;

/* ---------------------------------------------------------------------- */
/* Estates                                                                 */
/* ---------------------------------------------------------------------- */

export const estateCreateSchema = z.object({
  organizationId: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(2).max(160),
  marketId: uuidSchema.nullable().optional(),
  serviceChargePolicy: z
    .object({
      amountKobo: koboStringSchema,
      period: z.enum(['monthly', 'quarterly', 'annual']),
      description: z.string().trim().max(200).optional(),
    })
    .nullable()
    .optional(),
  visitorPolicyWebhookUrl: z.url().max(500).nullable().optional(),
  /** Ledger segment for separate accounting; derived from the name when omitted. */
  ledgerSegment: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/)
    .optional(),
});
export type EstateCreate = z.infer<typeof estateCreateSchema>;

export const estateDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  name: z.string(),
  marketId: uuidSchema.nullable(),
  serviceChargePolicy: z.record(z.string(), z.unknown()).nullable(),
  visitorPolicyWebhookUrl: z.string().nullable(),
  ledgerSegment: z.string(),
  propertyIds: z.array(uuidSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EstateDto = z.infer<typeof estateDtoSchema>;

export const estateServiceChargeRunSchema = z.object({
  periodStart: dateOnlySchema,
  periodEnd: dateOnlySchema,
  /** Overrides the estate policy amount for this run. */
  amountKobo: koboStringSchema.optional(),
  dueDate: dateOnlySchema.optional(),
});
export type EstateServiceChargeRun = z.infer<typeof estateServiceChargeRunSchema>;

export const estateServiceChargeResultSchema = z.object({
  invoiced: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invoiceIds: z.array(uuidSchema),
});

/* ---------------------------------------------------------------------- */
/* Short stay                                                              */
/* ---------------------------------------------------------------------- */

export const stayBookingStatusSchema = z.enum([
  'requested',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
]);

export const stayBookingCreateSchema = z.object({
  propertyId: uuidSchema,
  unitId: uuidSchema.nullable().optional(),
  guestName: z.string().trim().min(2).max(160),
  guestContact: z
    .object({ email: emailSchema.optional(), phoneE164: phoneE164Schema.optional() })
    .nullable()
    .optional(),
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  nightlyRateKobo: koboStringSchema,
  platformFeeKobo: koboStringSchema.default('0'),
  cleaningKobo: koboStringSchema.default('0'),
  channel: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type StayBookingCreate = z.infer<typeof stayBookingCreateSchema>;

export const stayBookingTransitionSchema = z.object({
  to: z.enum(['confirmed', 'checked_in', 'checked_out', 'cancelled']),
  reason: z.string().trim().max(1000).optional(),
});
export type StayBookingTransition = z.infer<typeof stayBookingTransitionSchema>;

export const stayBookingDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string(),
  propertyId: uuidSchema,
  unitId: uuidSchema.nullable(),
  guestName: z.string(),
  guestContact: z.record(z.string(), z.unknown()).nullable(),
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  nights: z.number().int(),
  nightlyRateKobo: koboStringSchema,
  grossKobo: koboStringSchema,
  platformFeeKobo: koboStringSchema,
  cleaningKobo: koboStringSchema,
  status: stayBookingStatusSchema,
  channel: z.string().nullable(),
  notes: z.string().nullable(),
  turnoverWorkOrderId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type StayBookingDto = z.infer<typeof stayBookingDtoSchema>;

export const stayCalendarQuerySchema = z.object({
  propertyId: uuidSchema,
  from: dateOnlySchema,
  to: dateOnlySchema,
});
export type StayCalendarQuery = z.infer<typeof stayCalendarQuerySchema>;
