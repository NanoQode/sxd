import { z } from 'zod';
import { dateOnlySchema, expectedVersionSchema, isoDateTimeSchema, uuidSchema } from './common';
import { expectedUpdatedAtSchema, reasonSchema, staffRoleSchema } from './admin-market-data';
import { quoteLineDtoSchema, quoteLineInputSchema } from './engagements';
import { engagementStatusSchema } from './portal';
import { reportKindSchema } from './projects';

/**
 * Admin configuration contracts: service price anchors (revisioned, published
 * by a second person), quotation templates, report templates, document
 * requirements, SLA policies and portfolio analytics. Mutations carry a reason
 * and the concurrency token the caller last saw.
 */

/* ---------------------------------------------------------------------- */
/* Price anchors                                                           */
/* ---------------------------------------------------------------------- */

export const priceBasisSchema = z.enum(['fixed', 'from', 'per_month', 'percentage', 'quotation']);
export type PriceBasisValue = z.infer<typeof priceBasisSchema>;

export const packagePublicationSchema = z.enum(['draft', 'in_review', 'published', 'retired']);

/** Bases that carry a naira amount (integer kobo); percentage carries basis points. */
export const AMOUNT_BASES: readonly PriceBasisValue[] = ['fixed', 'from', 'per_month'];

const positiveKoboSchema = z.string().regex(/^[1-9]\d{0,15}$/, 'positive integer kobo as a string');

export const priceAnchorValuesSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).nullable().default(null),
    scopeMarkdown: z.string().trim().max(8000).nullable().default(null),
    priceBasis: priceBasisSchema,
    /** Integer kobo; required for fixed, from and per_month, otherwise null. */
    amountKobo: positiveKoboSchema.nullable().default(null),
    /** Basis points (150 = 1.5%); required for percentage, otherwise null. */
    percentageBps: z.number().int().min(1).max(10_000).nullable().default(null),
    currency: z.literal('NGN').default('NGN'),
    minimumScope: z.string().trim().min(3).max(2000),
    exclusions: z.string().trim().min(3).max(2000),
    effectiveFrom: dateOnlySchema,
    effectiveTo: dateOnlySchema.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    const needsAmount = AMOUNT_BASES.includes(v.priceBasis);
    if (needsAmount && v.amountKobo === null)
      ctx.addIssue({ code: 'custom', path: ['amountKobo'], message: 'amount is required' });
    if (!needsAmount && v.amountKobo !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['amountKobo'],
        message: `a ${v.priceBasis} anchor has no amount`,
      });
    if (v.priceBasis === 'percentage' && v.percentageBps === null)
      ctx.addIssue({
        code: 'custom',
        path: ['percentageBps'],
        message: 'percentage basis points are required',
      });
    if (v.priceBasis !== 'percentage' && v.percentageBps !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['percentageBps'],
        message: 'only a percentage anchor carries basis points',
      });
    if (v.effectiveTo !== null && v.effectiveTo < v.effectiveFrom)
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'effective-to must be on or after effective-from',
      });
  });
export type PriceAnchorValues = z.infer<typeof priceAnchorValuesSchema>;

export const priceAnchorCreateSchema = z.object({
  serviceId: uuidSchema,
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens')
    .max(60),
  values: priceAnchorValuesSchema,
  note: z.string().trim().max(500).optional(),
});
export type PriceAnchorCreate = z.infer<typeof priceAnchorCreateSchema>;

export const priceAnchorDraftSchema = z.object({
  values: priceAnchorValuesSchema,
  /** Latest revision number the editor saw (0 when the package has none). */
  expectedRevision: z.number().int().min(0),
  note: z.string().trim().max(500).optional(),
});
export type PriceAnchorDraft = z.infer<typeof priceAnchorDraftSchema>;

export const priceAnchorActionSchema = z.enum(['submit', 'publish', 'reject', 'withdraw']);
export type PriceAnchorAction = z.infer<typeof priceAnchorActionSchema>;

export const priceAnchorTransitionSchema = z.object({
  action: priceAnchorActionSchema,
  expectedRevision: z.number().int().min(0),
  reason: reasonSchema,
});
export type PriceAnchorTransition = z.infer<typeof priceAnchorTransitionSchema>;

export const priceAnchorRetireSchema = z.object({
  expectedVersion: expectedVersionSchema,
  reason: reasonSchema,
});
export type PriceAnchorRetire = z.infer<typeof priceAnchorRetireSchema>;

const anchorValuesDtoSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  scopeMarkdown: z.string().nullable(),
  priceBasis: priceBasisSchema,
  amountKobo: z.string().nullable(),
  percentageBps: z.number().int().nullable(),
  currency: z.string(),
  minimumScope: z.string().nullable(),
  exclusions: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
});

const userRefSchema = z.object({ id: z.string(), name: z.string() });

export const priceAnchorRevisionDtoSchema = z.object({
  revision: z.number().int(),
  event: z.enum(['draft_saved', 'submitted', 'published', 'rejected', 'withdrawn', 'retired']),
  state: z.enum(['draft', 'in_review', 'published', 'rejected', 'withdrawn', 'retired']),
  values: anchorValuesDtoSchema,
  reason: z.string().nullable(),
  changedBy: userRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const priceAnchorDtoSchema = z.object({
  id: uuidSchema,
  serviceId: uuidSchema,
  serviceSlug: z.string(),
  serviceName: z.string(),
  slug: z.string(),
  publicationState: packagePublicationSchema,
  version: z.number().int(),
  live: anchorValuesDtoSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  reviewedBy: userRefSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  latestRevision: z.number().int(),
  proposal: z
    .object({
      state: z.enum(['draft', 'in_review']),
      /** True for a seeded anchor awaiting its first business review (no revision yet). */
      implicit: z.boolean(),
      values: anchorValuesDtoSchema,
      authors: z.array(userRefSchema),
      startedAt: isoDateTimeSchema.nullable(),
      updatedAt: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  revisions: z.array(priceAnchorRevisionDtoSchema).optional(),
});

/* ---------------------------------------------------------------------- */
/* Quote templates                                                         */
/* ---------------------------------------------------------------------- */

export const quoteTemplateListQuerySchema = z.object({
  serviceId: uuidSchema.optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
});

export const quoteTemplateCreateSchema = z.object({
  /** Null makes the template available for every service. */
  serviceId: uuidSchema.nullable(),
  name: z.string().trim().min(3).max(120),
  lines: z.array(quoteLineInputSchema).min(1).max(100),
  scopeMarkdown: z.string().trim().max(20_000).nullable().default(null),
  exclusions: z.string().trim().max(8000).nullable().default(null),
  active: z.boolean().default(true),
});
export type QuoteTemplateCreate = z.infer<typeof quoteTemplateCreateSchema>;

export const quoteTemplatePatchSchema = z.object({
  serviceId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(3).max(120).optional(),
  lines: z.array(quoteLineInputSchema).min(1).max(100).optional(),
  scopeMarkdown: z.string().trim().max(20_000).nullable().optional(),
  exclusions: z.string().trim().max(8000).nullable().optional(),
  active: z.boolean().optional(),
  reason: reasonSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type QuoteTemplatePatch = z.infer<typeof quoteTemplatePatchSchema>;

export const quoteTemplateDtoSchema = z.object({
  id: uuidSchema,
  serviceId: uuidSchema.nullable(),
  serviceName: z.string().nullable(),
  name: z.string(),
  lines: z.array(quoteLineDtoSchema),
  subtotalKobo: z.string(),
  scopeMarkdown: z.string().nullable(),
  exclusions: z.string().nullable(),
  active: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/* ---------------------------------------------------------------------- */
/* Report templates                                                        */
/* ---------------------------------------------------------------------- */

export const reportTemplateSectionSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,59}$/, 'snake_case key starting with a letter')
    .max(60),
  heading: z.string().trim().min(2).max(160),
  guidance: z.string().trim().max(2000).optional(),
  required: z.boolean(),
});

const sectionsSchema = z
  .array(reportTemplateSectionSchema)
  .min(1)
  .max(40)
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((s, i) => {
      if (seen.has(s.key))
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate key "${s.key}"` });
      seen.add(s.key);
    });
  });

export const reportTemplateListQuerySchema = z.object({ kind: reportKindSchema.optional() });

export const reportTemplateCreateSchema = z.object({
  kind: reportKindSchema,
  name: z.string().trim().min(3).max(120),
  sections: sectionsSchema,
  limitationsMarkdown: z.string().trim().min(10).max(8000),
  /** Activating a template deactivates the other template of the same kind. */
  active: z.boolean().default(false),
  reason: reasonSchema.optional(),
});
export type ReportTemplateCreate = z.infer<typeof reportTemplateCreateSchema>;

export const reportTemplatePatchSchema = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  sections: sectionsSchema.optional(),
  limitationsMarkdown: z.string().trim().min(10).max(8000).optional(),
  active: z.boolean().optional(),
  expectedVersion: expectedVersionSchema,
  reason: reasonSchema,
});
export type ReportTemplatePatch = z.infer<typeof reportTemplatePatchSchema>;

export const reportTemplateDtoSchema = z.object({
  id: uuidSchema,
  kind: reportKindSchema,
  name: z.string(),
  sections: z.array(reportTemplateSectionSchema),
  limitationsMarkdown: z.string().nullable(),
  active: z.boolean(),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/* ---------------------------------------------------------------------- */
/* Document requirements                                                   */
/* ---------------------------------------------------------------------- */

export const documentRequirementListQuerySchema = z.object({
  /** A service id, or "all" for requirements that apply to every service. */
  serviceId: z.union([uuidSchema, z.literal('all')]).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
});

export const documentRequirementCreateSchema = z.object({
  serviceId: uuidSchema.nullable(),
  name: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).nullable().default(null),
  /** Stage from which the document is needed; null means at intake. */
  stage: engagementStatusSchema.nullable().default(null),
  required: z.boolean().default(true),
  sensitive: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type DocumentRequirementCreate = z.infer<typeof documentRequirementCreateSchema>;

export const documentRequirementPatchSchema = z.object({
  serviceId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  stage: engagementStatusSchema.nullable().optional(),
  required: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  expectedVersion: expectedVersionSchema,
  reason: reasonSchema,
});
export type DocumentRequirementPatch = z.infer<typeof documentRequirementPatchSchema>;

export const documentRequirementDtoSchema = z.object({
  id: uuidSchema,
  serviceId: uuidSchema.nullable(),
  serviceName: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  stage: engagementStatusSchema.nullable(),
  required: z.boolean(),
  sensitive: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/* ---------------------------------------------------------------------- */
/* SLA policies                                                            */
/* ---------------------------------------------------------------------- */

/** Stages that can carry an SLA target (clock-stopped and closed stages cannot). */
export const slaStageSchema = z.enum([
  'inquiry',
  'triage',
  'quoted',
  'accepted',
  'awaiting_payment',
  'in_progress',
  'in_review',
  'delivered',
]);

export const slaPolicyCreateSchema = z.object({
  serviceId: uuidSchema.nullable(),
  stage: slaStageSchema,
  targetHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365),
  businessHoursOnly: z.boolean().default(true),
  escalateToRole: staffRoleSchema.nullable().default(null),
  active: z.boolean().default(true),
});
export type SlaPolicyCreate = z.infer<typeof slaPolicyCreateSchema>;

export const slaPolicyPatchSchema = z.object({
  targetHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .optional(),
  businessHoursOnly: z.boolean().optional(),
  escalateToRole: staffRoleSchema.nullable().optional(),
  active: z.boolean().optional(),
  reason: reasonSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type SlaPolicyPatch = z.infer<typeof slaPolicyPatchSchema>;

export const slaPolicyDtoSchema = z.object({
  id: uuidSchema,
  serviceId: uuidSchema.nullable(),
  serviceName: z.string().nullable(),
  stage: engagementStatusSchema,
  targetHours: z.number().int(),
  businessHoursOnly: z.boolean(),
  escalateToRole: z.string().nullable(),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/* ---------------------------------------------------------------------- */
/* Portfolio analytics                                                     */
/* ---------------------------------------------------------------------- */

export const portfolioAnalyticsQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    /** Limit every section to one customer organisation. */
    organizationId: z.string().trim().min(1).max(128).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from must be on or before to',
    path: ['from'],
  });
export type PortfolioAnalyticsQuery = z.infer<typeof portfolioAnalyticsQuerySchema>;

export const portfolioSectionSchema = z.enum([
  'properties',
  'occupancy',
  'arrears',
  'projects',
  'change_orders',
  'service_requests',
  'revenue',
]);
export type PortfolioSection = z.infer<typeof portfolioSectionSchema>;

export const portfolioExportQuerySchema = z
  .object({
    section: portfolioSectionSchema,
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    organizationId: z.string().trim().min(1).max(128).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from must be on or before to',
    path: ['from'],
  });
export type PortfolioExportQuery = z.infer<typeof portfolioExportQuerySchema>;

const kobo = z.string();

export const portfolioAnalyticsDtoSchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), asOf: z.string() }),
  organizationId: z.string().nullable(),
  generatedAt: isoDateTimeSchema,
  properties: z
    .object({
      propertyCount: z.number().int(),
      unitCount: z.number().int(),
      occupiedUnits: z.number().int(),
      vacantUnits: z.number().int(),
      occupancyPct: z.number().nullable(),
      activeLeases: z.number().int(),
      wholePropertyLeases: z.number().int(),
    })
    .nullable(),
  arrears: z
    .object({
      asOf: z.string(),
      invoiceCount: z.number().int(),
      outstandingKobo: kobo,
      overdueKobo: kobo,
      buckets: z.record(z.string(), kobo),
    })
    .nullable(),
  projects: z
    .object({
      scope: z.enum(['all', 'assigned']),
      activeCount: z.number().int(),
      withApprovedBudget: z.number().int(),
      approvedBudgetKobo: kobo,
      forecastFinalCostKobo: kobo,
      committedKobo: kobo,
      actualKobo: kobo,
      varianceKobo: kobo,
      overBudgetCount: z.number().int(),
    })
    .nullable(),
  changeOrders: z
    .object({
      scope: z.enum(['all', 'assigned']),
      openCount: z.number().int(),
      openExposureKobo: kobo,
      byStatus: z.record(z.string(), z.object({ count: z.number().int(), deltaKobo: kobo })),
    })
    .nullable(),
  serviceRequests: z
    .object({
      scope: z.enum(['all', 'assigned']),
      createdInRange: z.number().int(),
      byStatus: z.record(z.string(), z.number().int()),
      byService: z.array(
        z.object({
          serviceId: z.string(),
          serviceName: z.string(),
          total: z.number().int(),
          open: z.number().int(),
        }),
      ),
      sla: z.object({
        activePolicies: z.number().int(),
        openWithDueTime: z.number().int(),
        openBreaches: z.number().int(),
        dueSoon: z.number().int(),
      }),
    })
    .nullable(),
  revenue: z
    .object({
      totalKobo: kobo,
      lineCount: z.number().int(),
      months: z.array(z.object({ month: z.string(), revenueKobo: kobo })),
      byAccount: z.array(z.object({ code: z.string(), name: z.string(), revenueKobo: kobo })),
    })
    .nullable(),
});
export type PortfolioAnalyticsDto = z.infer<typeof portfolioAnalyticsDtoSchema>;
