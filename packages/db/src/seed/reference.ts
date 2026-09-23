import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import * as s from '../schema';
import { applyActorContext, systemContext } from '../tenant';

/**
 * Reference data required for the application to operate. Idempotent: every
 * insert is keyed by a stable code/slug/key and uses ON CONFLICT DO NOTHING so
 * operator edits are never overwritten by a re-run.
 */

export const chartOfAccounts: Array<typeof s.ledgerAccounts.$inferInsert> = [
  {
    code: '1000',
    name: 'Bank - operating',
    type: 'asset',
    normalBalance: 'debit',
    subtype: 'cash',
    isControl: true,
  },
  {
    code: '1100',
    name: 'Gateway clearing - Paystack',
    type: 'asset',
    normalBalance: 'debit',
    subtype: 'clearing',
    isControl: true,
    description: 'Funds confirmed by the gateway but not yet settled to bank.',
  },
  {
    code: '1200',
    name: 'Customer receivables',
    type: 'asset',
    normalBalance: 'debit',
    subtype: 'receivable',
    isControl: true,
  },
  {
    code: '1300',
    name: 'Rent receivable (collected on behalf of owners)',
    type: 'asset',
    normalBalance: 'debit',
    subtype: 'receivable',
    isControl: true,
  },
  {
    code: '1400',
    name: 'Bank transfers pending confirmation',
    type: 'asset',
    normalBalance: 'debit',
    subtype: 'suspense',
    description: 'Declared transfers are not cleared money until finance confirms them.',
  },
  {
    code: '2000',
    name: 'Customer deposits and unearned revenue',
    type: 'liability',
    normalBalance: 'credit',
    subtype: 'deferred',
    isControl: true,
  },
  {
    code: '2100',
    name: 'Rent collected - payable to owners',
    type: 'liability',
    normalBalance: 'credit',
    subtype: 'trust',
    isControl: true,
    description: "Customer rents collected on an owner's behalf are liabilities, not revenue.",
  },
  {
    code: '2200',
    name: 'Refunds payable',
    type: 'liability',
    normalBalance: 'credit',
    subtype: 'payable',
  },
  {
    code: '2300',
    name: 'Tax and withholding payable',
    type: 'liability',
    normalBalance: 'credit',
    subtype: 'tax',
  },
  {
    code: '2400',
    name: 'Partner and supplier payables',
    type: 'liability',
    normalBalance: 'credit',
    subtype: 'payable',
  },
  {
    code: '2500',
    name: 'Chargebacks pending',
    type: 'liability',
    normalBalance: 'credit',
    subtype: 'dispute',
  },
  { code: '3000', name: 'Retained earnings', type: 'equity', normalBalance: 'credit' },
  {
    code: '4000',
    name: 'Service revenue',
    type: 'revenue',
    normalBalance: 'credit',
    subtype: 'services',
  },
  {
    code: '4100',
    name: 'Management fee revenue',
    type: 'revenue',
    normalBalance: 'credit',
    subtype: 'management',
  },
  {
    code: '4200',
    name: 'Tender and procurement fee revenue',
    type: 'revenue',
    normalBalance: 'credit',
    subtype: 'commercial',
  },
  {
    code: '4300',
    name: 'Referral and placement revenue',
    type: 'revenue',
    normalBalance: 'credit',
    subtype: 'referrals',
  },
  { code: '5000', name: 'Gateway fees', type: 'expense', normalBalance: 'debit', subtype: 'fees' },
  {
    code: '5100',
    name: 'Refund and chargeback losses',
    type: 'expense',
    normalBalance: 'debit',
    subtype: 'losses',
  },
  {
    code: '5200',
    name: 'Maintenance and estate expenses (recoverable)',
    type: 'expense',
    normalBalance: 'debit',
    subtype: 'recoverable',
  },
  {
    code: '5300',
    name: 'Partner professional fees',
    type: 'expense',
    normalBalance: 'debit',
    subtype: 'cost_of_service',
  },
];

interface ServiceSeed {
  slug: string;
  name: string;
  category: 'core' | 'expansion';
  shortDescription: string;
  deliverables: string[];
  completionEvidence: string;
  workflowTemplateKey: string;
  commercialModel?: string;
  iconKey?: string;
  sortOrder: number;
  package?: {
    slug: string;
    name: string;
    priceBasis: 'fixed' | 'from' | 'per_month' | 'percentage' | 'quotation';
    amountNaira?: number;
    percentageBps?: number;
    minimumScope: string;
    exclusions: string;
  };
}

export const coreServices: ServiceSeed[] = [
  {
    slug: 'construction-monitoring',
    name: 'Construction monitoring',
    category: 'core',
    shortDescription:
      'Independent oversight of your build with baseline budgets, milestone plans, site visits and evidence-backed progress reports.',
    deliverables: [
      'Project baseline and BOQ',
      'Budget commitments and actuals',
      'Milestone plan',
      'Site visits with photo, video and drone evidence',
      'Versioned progress reports',
      'Defects and material checks',
      'Change orders with owner approvals',
    ],
    completionEvidence:
      'Versioned reviewed report, unresolved issues list and milestone acceptance',
    workflowTemplateKey: 'construction_monitoring',
    iconKey: 'hard-hat',
    sortOrder: 1,
    package: {
      slug: 'standard',
      name: 'Monitoring engagement',
      priceBasis: 'from',
      amountNaira: 150000,
      minimumScope: 'One project, scheduled site visits and reports as scoped in the quotation.',
      exclusions:
        'Contractor works, materials, approvals fees and travel outside the agreed coverage area.',
    },
  },
  {
    slug: 'due-diligence',
    name: 'Due diligence',
    category: 'core',
    shortDescription:
      'Title and document checks, survey references, professional site findings and a clear decision memorandum before you commit.',
    deliverables: [
      'Property intake and document checklist',
      'Survey references',
      'Legal and surveyor assignments',
      'Site findings and queries',
      'Red flags',
      'Decision memorandum',
    ],
    completionEvidence:
      'Named professional reviewer, evidence references and clear scope/limitations; no automatic legal guarantee',
    workflowTemplateKey: 'due_diligence',
    iconKey: 'search-check',
    sortOrder: 2,
    package: {
      slug: 'standard',
      name: 'Due diligence engagement',
      priceBasis: 'from',
      amountNaira: 100000,
      minimumScope: 'One property; document review and one site visit as scoped.',
      exclusions: 'Government search fees, court processes, litigation and valuation reports.',
    },
  },
  {
    slug: 'architectural-services',
    name: 'Architectural services',
    category: 'core',
    shortDescription:
      'Briefs, design options, drawings, revisions and approvals tracking with a versioned deliverable you sign off.',
    deliverables: [
      'Design brief and site information',
      'Design options',
      'Drawings and revisions with comments',
      'Approvals tracker',
      'BOQ and professional handoffs',
    ],
    completionEvidence: 'Customer signoff on a versioned deliverable and revision history',
    workflowTemplateKey: 'architecture',
    iconKey: 'drafting-compass',
    sortOrder: 3,
    package: {
      slug: 'standard',
      name: 'Architecture engagement',
      priceBasis: 'from',
      amountNaira: 250000,
      minimumScope: 'Concept and design development as scoped in the quotation.',
      exclusions:
        'Statutory approval fees, structural and MEP engineering unless scoped, and site supervision.',
    },
  },
  {
    slug: 'property-management',
    name: 'Property management',
    category: 'core',
    shortDescription:
      'Units, leases, rent schedules, collections, maintenance and owner statements that reconcile.',
    deliverables: [
      'Properties and units register',
      'Leases and rent schedules',
      'Collections and arrears tracking',
      'Maintenance and recurring inspections',
      'Owner statements and tenant tickets',
    ],
    completionEvidence: 'Reconciled period statement and open obligations',
    workflowTemplateKey: 'property_management',
    iconKey: 'building',
    sortOrder: 4,
    package: {
      slug: 'monthly',
      name: 'Management retainer',
      priceBasis: 'per_month',
      amountNaira: 75000,
      minimumScope: 'One property with up to the number of units agreed in the quotation.',
      exclusions: 'Repair costs, service charges, legal recovery and utilities.',
    },
  },
  {
    slug: 'virtual-inspections',
    name: 'Virtual inspections',
    category: 'core',
    shortDescription:
      'Scheduled inspections with checklists, photos, video, optional live meeting and a reviewed report you can act on.',
    deliverables: [
      'Appointment and checklist',
      'Photos and video',
      'Optional live meeting',
      'Annotated findings with defect severity',
      'Report export',
    ],
    completionEvidence: 'Reviewed inspection report and customer access',
    workflowTemplateKey: 'virtual_inspection',
    iconKey: 'video',
    sortOrder: 5,
    package: {
      slug: 'single',
      name: 'Single virtual inspection',
      priceBasis: 'from',
      amountNaira: 50000,
      minimumScope: 'One property visit and one reviewed report.',
      exclusions: 'Travel beyond the agreed coverage area and specialist testing.',
    },
  },
  {
    slug: 'purchase-support',
    name: 'Purchase representation',
    category: 'core',
    shortDescription:
      'Search criteria, shortlist, offers, negotiation log, conditions and a closing checklist with document handover.',
    deliverables: [
      'Search criteria and shortlist',
      'Offers and negotiation log',
      'Conditions and diligence dependency',
      'Closing checklist',
      'Document handover',
    ],
    completionEvidence: 'Approved closing pack and agreed fee basis',
    workflowTemplateKey: 'purchase_support',
    iconKey: 'handshake',
    sortOrder: 6,
    package: {
      slug: 'percentage',
      name: 'Purchase representation',
      priceBasis: 'percentage',
      percentageBps: 150,
      minimumScope: 'Fee is calculated only on an agreed percentage basis and signed scope.',
      exclusions: 'Purchase price, legal fees, government charges and third-party diligence.',
    },
  },
  {
    slug: 'property-search',
    name: 'Property search',
    category: 'core',
    shortDescription:
      'Requirements, saved searches, shortlist comparison, alerts and viewing bookings with feedback.',
    deliverables: [
      'Requirements capture',
      'Saved searches and alerts',
      'Shortlist comparison',
      'Viewing bookings',
      'Feedback log',
    ],
    completionEvidence: 'Accepted shortlist or documented search outcome',
    workflowTemplateKey: 'property_search',
    iconKey: 'map-pin',
    sortOrder: 7,
    package: {
      slug: 'standard',
      name: 'Search engagement',
      priceBasis: 'from',
      amountNaira: 80000,
      minimumScope: 'One search brief with viewings as scoped in the quotation.',
      exclusions: 'Purchase or lease costs, legal fees and due diligence.',
    },
  },
  {
    slug: 'land-sales-leasing',
    name: 'Land sales and leasing',
    category: 'core',
    shortDescription:
      'Authorised listings with title disclosures, moderated media, qualified inquiries, offers and lease milestones.',
    deliverables: [
      'Owner authority verification',
      'Parcel and area records',
      'Title disclosures',
      'Listing moderation',
      'Inquiry qualification',
      'Offers and lease milestones',
    ],
    completionEvidence: 'Authorized listing and documented transaction/lease outcome',
    workflowTemplateKey: 'land_sales_leasing',
    iconKey: 'landmark',
    sortOrder: 8,
    package: {
      slug: 'quotation',
      name: 'Sales or leasing mandate',
      priceBasis: 'quotation',
      minimumScope: 'Scoped per mandate.',
      exclusions: 'Government consent fees, survey and legal costs.',
    },
  },
];

export const expansionServices: ServiceSeed[] = [
  [
    'contractor-tendering',
    'Contractor tendering',
    'Scope and BOQ, qualification, sealed submissions, clarifications, weighted evaluation, award, variations and performance.',
    'Tender-management fee; disclosed partner relationships',
    'contractor_tendering',
  ],
  [
    'materials-procurement',
    'Materials procurement',
    'Supplier directory, RFQs, normalised units, delivered-cost comparisons, purchase orders, delivery evidence, discrepancies and returns.',
    'Procurement service fee or disclosed margin',
    'materials_procurement',
  ],
  [
    'quantity-surveying',
    'Quantity surveying',
    'Versioned estimate, BOQ, valuation, cost-to-complete and change control.',
    'Professional assignment and scoped fee',
    'quantity_surveying',
  ],
  [
    'independent-snagging',
    'Independent snagging',
    'Pre-handover checklist, defects, accountability, reinspection and closure.',
    'Per inspection or package',
    'snagging',
  ],
  [
    'renovation-retrofit',
    'Renovation and retrofit',
    'Existing-condition survey, option comparison, budget, tender and monitored delivery.',
    'Project fee using the project engine',
    'renovation',
  ],
  [
    'preventive-maintenance',
    'Preventive maintenance',
    'Asset register, warranty dates, recurring work orders, contractor dispatch and SLA reporting.',
    'Subscription or work-order pricing',
    'preventive_maintenance',
  ],
  [
    'facilities-estate-management',
    'Facilities and estate management',
    'Shared assets, service charges, resident issues, visitor-policy hooks and statements.',
    'Estate contract, separate accounting by estate',
    'estate_management',
  ],
  [
    'rental-placement',
    'Rental placement',
    'Listing, viewings, applications, consent-based screening, offer, lease and move-in inventory.',
    'Agreed placement fee',
    'rental_placement',
  ],
  [
    'student-housing',
    'Student housing',
    'Bed and unit inventory, academic-period lease schedules, guarantors and maintenance.',
    'Specialist management package',
    'student_housing',
  ],
  [
    'short-stay-management',
    'Short-stay management',
    'Calendar and inventory, booking requests, turnover tasks, expenses and owner statements.',
    'Management contract; channel-manager connector as a later integration',
    'short_stay',
  ],
  [
    'commercial-industrial',
    'Commercial and industrial property',
    'Property-type specific search, fit-out requirements, leases and compliance checklist.',
    'Mandated search or management assignment',
    'commercial_property',
  ],
  [
    'landowner-developer-matching',
    'Landowner and developer matching',
    'Opportunity profile, controlled data room, proposals and adviser review.',
    'Introductions or mandate fee with conflict disclosure',
    'landowner_matching',
  ],
  [
    'investment-feasibility',
    'Investment feasibility',
    'Saved market comparison, cost and rent scenarios, sensitivity and reviewed feasibility report.',
    'Paid professional report',
    'investment_feasibility',
  ],
  [
    'energy-water-upgrades',
    'Energy and water upgrades',
    'Load and condition survey, solar and water options, quotes, installation evidence and warranty.',
    'Vendor-managed project package',
    'energy_water',
  ],
  [
    'insurance-finance-referrals',
    'Insurance and finance referrals',
    'Customer consent, partner referral, document handoff and status tracking.',
    'Disclosed referral arrangement; no loan approval promises',
    'referrals',
  ],
  [
    'valuation-referrals',
    'Valuation referrals',
    'Purpose, property details, qualified valuer assignment and report.',
    "Qualified professional's scoped service",
    'valuation_referral',
  ],
  [
    'portfolio-reporting',
    'Portfolio reporting',
    'Consolidated ownership, rent, expenses, project exposure, geographic mix and export.',
    'Owner or institutional reporting subscription',
    'portfolio_reporting',
  ],
  [
    'diaspora-concierge',
    'Diaspora concierge',
    'Time-zone-aware coordinator, delegated approvals, evidence digests and family access.',
    'Service tier with explicit SLA',
    'diaspora_concierge',
  ],
  [
    'professional-partner-network',
    'Professional partner network',
    'Credentials, coverage, availability, conflict disclosures, reviews and expiry.',
    'Verified membership or assignment; badge states what was checked',
    'partner_network',
  ],
  [
    'market-intelligence',
    'Market intelligence',
    'Licensed and first-party data collection, trend views, methodology, alerts and exports.',
    'Subscription research product after adequate coverage',
    'market_intelligence',
  ],
  [
    'dispute-support',
    'Dispute support',
    'Evidence chronology, issue tracking and professional referral.',
    'Administrative case support; no automated legal decision',
    'dispute_support',
  ],
  [
    'document-renewals',
    'Document renewals',
    'Expiry reminders, document requests and professional processing tasks.',
    'Renewal-support package',
    'document_renewals',
  ],
  [
    'ai-assisted-operations',
    'AI-assisted operations',
    'Draft report summaries, defect classification for human review and search of authorised documents.',
    'Optional assistive feature with provenance and opt-out',
    'ai_assist',
  ],
].map(([slug, name, description, commercialModel, workflowTemplateKey], i) => ({
  slug: slug!,
  name: name!,
  category: 'expansion' as const,
  shortDescription: description!,
  deliverables: [],
  completionEvidence: 'Documented outcome per activated workflow template',
  workflowTemplateKey: workflowTemplateKey!,
  commercialModel: commercialModel!,
  sortOrder: 100 + i,
}));

export const regulatedFlags = [
  [
    'regulated.pooled_investment',
    'Pooled investment',
    'Not an ordinary portal feature. Requires operating model, licensed providers and professional review before any activation.',
  ],
  [
    'regulated.fractional_ownership',
    'Fractional ownership',
    'Not an ordinary portal feature. Represented only through the data-room and referral workflows until a compliant model exists.',
  ],
  [
    'regulated.customer_wallet',
    'Customer fund wallets',
    'Customer funds are never held as balances. Ordinary gateway payments only.',
  ],
  [
    'regulated.escrow_custody',
    'Escrow custody',
    'No escrow badge for ordinary gateway payments. Requires a licensed escrow provider and legal review.',
  ],
  [
    'regulated.lending',
    'Lending',
    'Referral workflow only; no lending, loan approvals or promises.',
  ],
  [
    'regulated.automated_legal_certification',
    'Automated legal certification',
    'Due diligence memoranda are professional opinions with named reviewers; no automated certification.',
  ],
] as const;

export const freshnessDefaults = [
  {
    dataType: 'material_quote',
    maxAgeDays: 14,
    respectSourceValidity: true,
    note: '14 days or the supplier expiry, whichever is sooner.',
  },
  {
    dataType: 'rent_observation',
    maxAgeDays: 90,
    respectSourceValidity: true,
    note: 'Advertised or transaction rents.',
  },
  {
    dataType: 'sale_observation',
    maxAgeDays: 90,
    respectSourceValidity: true,
    note: 'Advertised or transaction sale prices.',
  },
  {
    dataType: 'official_risk_layer',
    maxAgeDays: null,
    respectSourceValidity: true,
    note: "Valid until the next official edition; the report's own validity takes precedence.",
  },
  {
    dataType: 'observed_permit_performance',
    maxAgeDays: 180,
    respectSourceValidity: true,
    note: 'Observed processing times from completed cases.',
  },
  {
    dataType: 'build_rate',
    maxAgeDays: 90,
    respectSourceValidity: true,
    note: 'Architect or quantity surveyor estimates.',
  },
];

export const rankingPolicyV1: typeof s.rankingPolicies.$inferInsert = {
  version: 1,
  name: 'Proposed product defaults v1',
  status: 'active',
  weights: {
    affordability: 0.25,
    material_access: 0.15,
    net_rental_economics: 0.2,
    construction_duration: 0.1,
    approval_duration: 0.1,
    evidence_backed_demand: 0.1,
    infrastructure_site_suitability: 0.1,
  },
  metricBounds: [
    {
      metric: 'affordability',
      direction: 'lower_is_better',
      unit: 'NGN/m2',
      low: 150000,
      high: 900000,
      note: 'Proposed normalisation anchors for assumption-mode comparison; not researched market facts. Data approver must review.',
    },
    {
      metric: 'material_access',
      direction: 'lower_is_better',
      unit: 'days',
      low: 1,
      high: 21,
      note: 'Proposed anchor; requires verified supplier quotes to become evidence-backed.',
    },
    {
      metric: 'net_rental_economics',
      direction: 'higher_is_better',
      unit: 'percent',
      low: 0,
      high: 12,
      note: 'Proposed anchor; yields are only computed from matched cohort rents and validated costs.',
    },
    {
      metric: 'construction_duration',
      direction: 'lower_is_better',
      unit: 'days',
      low: 120,
      high: 720,
      note: 'Proposed anchor; scoped schedules only.',
    },
    {
      metric: 'approval_duration',
      direction: 'lower_is_better',
      unit: 'days',
      low: 14,
      high: 365,
      note: 'Proposed anchor; observed durations from the relevant authority only.',
    },
    {
      metric: 'evidence_backed_demand',
      direction: 'higher_is_better',
      unit: 'index',
      low: 0,
      high: 100,
      note: 'Proposed anchor; requires first-party or licensed demand evidence.',
    },
    {
      metric: 'infrastructure_site_suitability',
      direction: 'higher_is_better',
      unit: 'index',
      low: 0,
      high: 100,
      note: 'Unknown flood or title status never scores as low risk.',
    },
  ],
  confidenceRubric: {
    sourceQuality: {
      first_party_verified: 1,
      licensed_dataset: 0.9,
      official_publication: 0.9,
      published_report_read: 0.6,
      unverified_lead: 0.3,
      user_assumption: 0.5,
    },
    freshness: { within_policy: 1, stale: 0 },
    geographicMatch: { site: 1, neighborhood: 0.9, city: 0.8, state_or_fct: 0.4, country: 0.2 },
    sampleSize: {
      thresholds: [
        { min: 30, multiplier: 1 },
        { min: 10, multiplier: 0.8 },
        { min: 3, multiplier: 0.5 },
        { min: 1, multiplier: 0.3 },
      ],
    },
    note: 'Multipliers are configuration reviewed by the data approver, not hidden judgments.',
  },
  coverageThreshold: '0.7000',
  minComparables: 10,
  hardConstraints: {
    unknownFloodIsNotLowRisk: true,
    unknownTitleIsNotLowRisk: true,
    sponsoredPlacementsSeparate: true,
  },
  notes:
    'Initial configurable weights from the build brief: proposed product defaults, not researched investment truths.',
};

export const taxTreatmentDefaults = [
  {
    key: 'none',
    name: 'No tax applied',
    rateBps: 0,
    withholdingBps: 0,
    appliesTo: 'all',
    note: 'Default until the business accountant reviews treatments per service and rental type.',
  },
  {
    key: 'vat_standard',
    name: 'VAT (standard rate, unreviewed)',
    rateBps: 750,
    withholdingBps: 0,
    appliesTo: 'service',
    note: 'Placeholder pending accountant review; not applied automatically.',
    active: false,
  },
];

export const bookingDefaults = {
  consultation_duration_minutes: 30,
  buffer_minutes: 10,
  hold_ttl_minutes: 10,
  working_hours: { timeZone: 'Africa/Lagos', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
  holidays: [] as string[],
  cancellation_policy:
    'Consultations can be rescheduled or cancelled up to 12 hours before the start time from the appointment link.',
  min_notice_hours: 12,
  max_days_ahead: 60,
  routing: 'round_robin',
};

export const settingDefaults: Array<{ key: string; value: unknown; description: string }> = [
  { key: 'brand.name', value: 'SimplexD', description: 'Brand name shown across surfaces.' },
  {
    key: 'brand.tagline',
    value: 'Property services and oversight for Nigerians at home and abroad.',
    description: 'Public tagline; replace with approved copy.',
  },
  {
    key: 'brand.theme_default',
    value: 'system',
    description: 'Organisation default theme; never overrides a user preference.',
  },
  {
    key: 'brand.assets_approved',
    value: false,
    description: 'Set true once the owner supplies approved logos and photography.',
  },
  {
    key: 'business.time_zone',
    value: 'Africa/Lagos',
    description: 'Business time zone for scheduling and statements.',
  },
  { key: 'uploads.max_bytes', value: 2147483648, description: 'Maximum upload size in bytes.' },
  {
    key: 'uploads.allowed_mime',
    value: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'video/mp4',
      'video/quicktime',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/json',
      'application/dxf',
      'application/zip',
    ],
    description: 'Allowed upload MIME types; SVG/HTML/scripts are rejected.',
  },
  {
    key: 'retention.evidence_years',
    value: 7,
    description: 'Minimum retention for evidence linked to financial or legal records.',
  },
  {
    key: 'retention.analytics_days',
    value: 400,
    description: 'Consent-aware analytics retention.',
  },
  {
    key: 'publication.min_comparables',
    value: 10,
    description:
      'Deduplicated comparable listings required before publishing a local median (publication policy, not a statistical guarantee).',
  },
  {
    key: 'ranking.coverage_threshold',
    value: 0.7,
    description: 'Minimum weighted coverage for an investment ranking.',
  },
  {
    key: 'notifications.quiet_hours',
    value: { start: '21:00', end: '07:00' },
    description: 'Default quiet hours for non-urgent notifications (customer time zone).',
  },
  {
    key: 'security.staff_mfa_required',
    value: true,
    description:
      'Require authenticator MFA for finance, access, data-publication and integration permissions.',
  },
  {
    key: 'analytics.consent_version',
    value: '2026-09',
    description: 'Consent policy version recorded with analytics events.',
  },
];

export async function seedReferenceData(
  db: Database,
  actorUserId: string | null = null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await applyActorContext(tx, systemContext('seed-reference'));

    await tx
      .insert(s.ledgerAccounts)
      .values(chartOfAccounts)
      .onConflictDoNothing({ target: s.ledgerAccounts.code });

    for (const svc of [...coreServices, ...expansionServices]) {
      const existing = await tx
        .select({ id: s.services.id })
        .from(s.services)
        .where(eq(s.services.slug, svc.slug));
      let serviceId = existing[0]?.id;
      if (!serviceId) {
        const [row] = await tx
          .insert(s.services)
          .values({
            slug: svc.slug,
            name: svc.name,
            category: svc.category,
            shortDescription: svc.shortDescription,
            deliverables: svc.deliverables,
            completionEvidence: svc.completionEvidence,
            workflowTemplateKey: svc.workflowTemplateKey,
            featureFlagKey:
              svc.category === 'expansion' ? `expansion.${svc.workflowTemplateKey}` : null,
            bookingEnabled: svc.category === 'core',
            inquiryEnabled: true,
            staffed: false,
            commercialModel: svc.commercialModel ?? null,
            sortOrder: svc.sortOrder,
            iconKey: svc.iconKey ?? null,
            publicationState: svc.category === 'core' ? 'published' : 'draft',
          })
          .returning({ id: s.services.id });
        serviceId = row!.id;
      }
      if (svc.package) {
        await tx
          .insert(s.servicePackages)
          .values({
            serviceId,
            slug: svc.package.slug,
            name: svc.package.name,
            priceBasis: svc.package.priceBasis,
            amountKobo:
              svc.package.amountNaira !== undefined ? BigInt(svc.package.amountNaira) * 100n : null,
            percentageBps: svc.package.percentageBps ?? null,
            minimumScope: svc.package.minimumScope,
            exclusions: svc.package.exclusions,
            effectiveFrom: '2026-09-22',
            // Price anchors come from the current homepage and require business review before publication.
            publicationState: 'in_review',
            createdBy: actorUserId,
          })
          .onConflictDoNothing();
      }
      if (svc.category === 'expansion') {
        await tx
          .insert(s.featureFlags)
          .values({
            key: `expansion.${svc.workflowTemplateKey}`,
            name: svc.name,
            description: `Activates the ${svc.name} workflow, its portal surfaces and endpoints. Keep unstaffed services unavailable for booking.`,
            category: 'expansion',
            enabled: false,
          })
          .onConflictDoNothing();
      }
    }

    for (const [key, name, description] of regulatedFlags) {
      await tx
        .insert(s.featureFlags)
        .values({
          key,
          name,
          description,
          category: 'regulated_gated',
          enabled: false,
          requiresReview: true,
          reviewNote: 'Requires operating model, providers and professional review.',
        })
        .onConflictDoNothing();
    }

    await tx
      .insert(s.featureFlags)
      .values([
        {
          key: 'core.public_listings',
          name: 'Public property listings',
          description: 'Show moderated listings on the public site.',
          category: 'core',
          enabled: true,
        },
        {
          key: 'core.anonymous_scenarios',
          name: 'Anonymous scenario saving',
          description: 'Allow visitors to save scenarios before creating an account.',
          category: 'core',
          enabled: true,
        },
        {
          key: 'core.bank_transfer_receipts',
          name: 'Bank transfer receipts',
          description: 'Allow customers to declare bank transfers for finance confirmation.',
          category: 'core',
          enabled: true,
        },
        {
          key: 'core.impersonation',
          name: 'Support impersonation',
          description: 'Permission-gated, audited, time-limited impersonation for support.',
          category: 'core',
          enabled: false,
          requiresReview: true,
        },
      ])
      .onConflictDoNothing();

    for (const f of freshnessDefaults) {
      await tx.insert(s.freshnessPolicies).values(f).onConflictDoNothing();
    }

    await tx
      .insert(s.rankingPolicies)
      .values({ ...rankingPolicyV1, activatedAt: new Date(), createdBy: actorUserId })
      .onConflictDoNothing({ target: s.rankingPolicies.version });

    for (const t of taxTreatmentDefaults) {
      await tx.insert(s.taxTreatments).values(t).onConflictDoNothing();
    }

    for (const [key, value] of Object.entries(bookingDefaults)) {
      await tx.insert(s.bookingSettings).values({ key, value }).onConflictDoNothing();
    }

    for (const st of settingDefaults) {
      await tx
        .insert(s.settings)
        .values({ key: st.key, value: st.value as object, description: st.description })
        .onConflictDoNothing();
    }

    await tx
      .insert(s.dataPolicySettings)
      .values([
        {
          key: 'ranking.coverage_threshold',
          value: 0.7,
          description: 'Minimum weighted coverage for investment ranking.',
        },
        {
          key: 'publication.min_comparables',
          value: 10,
          description: 'Deduplicated comparables required before publishing a local median.',
        },
        {
          key: 'ranking.require_local_cost_and_rent',
          value: true,
          description: 'Investment ranking requires locally applicable cost AND rental inputs.',
        },
      ])
      .onConflictDoNothing();

    for (const t of notificationTemplates) {
      await tx
        .insert(s.templates)
        .values({ ...t, status: 'approved' })
        .onConflictDoNothing();
    }
  });
}

export const notificationTemplates: Array<{
  key: string;
  channel: 'email' | 'sms' | 'in_app';
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  variables: string[];
}> = [
  {
    key: 'booking_confirmation',
    channel: 'email',
    subject: 'Your SimplexD consultation is confirmed',
    bodyText:
      'Hello {{name}},\n\nYour {{kind}} is confirmed for {{startsAtCustomer}} ({{customerTimeZone}}) / {{startsAtBusiness}} ({{businessTimeZone}}).\n\nManage or reschedule: {{manageUrl}}\n\nSimplexD',
    variables: [
      'name',
      'kind',
      'startsAtCustomer',
      'customerTimeZone',
      'startsAtBusiness',
      'businessTimeZone',
      'manageUrl',
    ],
  },
  {
    key: 'booking_confirmation',
    channel: 'sms',
    bodyText:
      'SimplexD: your {{kind}} is confirmed for {{startsAtCustomer}}. Details: {{manageUrl}}',
    variables: ['kind', 'startsAtCustomer', 'manageUrl'],
  },
  {
    key: 'booking_reminder',
    channel: 'email',
    subject: 'Reminder: your SimplexD appointment',
    bodyText:
      'Hello {{name}},\n\nReminder: your {{kind}} starts at {{startsAtCustomer}} ({{customerTimeZone}}).\n\nDetails: {{manageUrl}}',
    variables: ['name', 'kind', 'startsAtCustomer', 'customerTimeZone', 'manageUrl'],
  },
  {
    key: 'booking_reminder',
    channel: 'sms',
    bodyText: 'SimplexD reminder: {{kind}} at {{startsAtCustomer}}. {{manageUrl}}',
    variables: ['kind', 'startsAtCustomer', 'manageUrl'],
  },
  {
    key: 'visit_change',
    channel: 'email',
    subject: 'Your SimplexD visit has changed',
    bodyText:
      'Hello {{name}},\n\nYour {{kind}} was {{change}}. New time: {{startsAtCustomer}} ({{customerTimeZone}}).\n\nDetails: {{manageUrl}}',
    variables: ['name', 'kind', 'change', 'startsAtCustomer', 'customerTimeZone', 'manageUrl'],
  },
  {
    key: 'visit_change',
    channel: 'sms',
    bodyText: 'SimplexD: your {{kind}} was {{change}}. See {{manageUrl}}',
    variables: ['kind', 'change', 'manageUrl'],
  },
  {
    key: 'invoice_due',
    channel: 'email',
    subject: 'Invoice {{invoiceNumber}} is due',
    bodyText:
      'Hello {{name}},\n\nInvoice {{invoiceNumber}} for {{amount}} is due on {{dueDate}}.\n\nView and pay securely: {{invoiceUrl}}',
    variables: ['name', 'invoiceNumber', 'amount', 'dueDate', 'invoiceUrl'],
  },
  {
    key: 'invoice_due',
    channel: 'sms',
    bodyText:
      'SimplexD: invoice {{invoiceNumber}} ({{amount}}) is due {{dueDate}}. Sign in to view: {{invoiceUrl}}',
    variables: ['invoiceNumber', 'amount', 'dueDate', 'invoiceUrl'],
  },
  {
    key: 'report_ready',
    channel: 'email',
    subject: 'A new report is ready: {{reportTitle}}',
    bodyText:
      'Hello {{name}},\n\n{{reportTitle}} has been reviewed and released.\n\nSign in to read it: {{reportUrl}}',
    variables: ['name', 'reportTitle', 'reportUrl'],
  },
  {
    key: 'report_ready',
    channel: 'sms',
    bodyText: 'SimplexD: a report is ready. Sign in to view: {{reportUrl}}',
    variables: ['reportUrl'],
  },
  {
    key: 'urgent_decision',
    channel: 'email',
    subject: 'Decision required: {{subject}}',
    bodyText:
      'Hello {{name}},\n\nA decision is required: {{subject}}. Please respond by {{dueAt}}.\n\nSign in: {{decisionUrl}}',
    variables: ['name', 'subject', 'dueAt', 'decisionUrl'],
  },
  {
    key: 'urgent_decision',
    channel: 'sms',
    bodyText: 'SimplexD: a decision is required by {{dueAt}}. Sign in: {{decisionUrl}}',
    variables: ['dueAt', 'decisionUrl'],
  },
  {
    key: 'quote_issued',
    channel: 'email',
    subject: 'Your quotation is ready',
    bodyText:
      'Hello {{name}},\n\nQuotation {{reference}} version {{version}} is ready for your review.\n\nReview and accept: {{quoteUrl}}',
    variables: ['name', 'reference', 'version', 'quoteUrl'],
  },
  {
    key: 'payment_receipt',
    channel: 'email',
    subject: 'Payment received for invoice {{invoiceNumber}}',
    bodyText:
      'Hello {{name}},\n\nWe received {{amount}} for invoice {{invoiceNumber}}. Receipt {{receiptNumber}} is available in your portal: {{receiptUrl}}',
    variables: ['name', 'amount', 'invoiceNumber', 'receiptNumber', 'receiptUrl'],
  },
  {
    key: 'email_verification',
    channel: 'email',
    subject: 'Verify your SimplexD email',
    bodyText:
      'Hello {{name}},\n\nConfirm your email address: {{verifyUrl}}\n\nIf you did not create an account, ignore this message.',
    variables: ['name', 'verifyUrl'],
  },
  {
    key: 'password_reset',
    channel: 'email',
    subject: 'Reset your SimplexD password',
    bodyText:
      'Hello {{name}},\n\nReset your password: {{resetUrl}}\n\nThis link expires in {{expiresIn}}.',
    variables: ['name', 'resetUrl', 'expiresIn'],
  },
  {
    key: 'invitation',
    channel: 'email',
    subject: 'You have been invited to {{organizationName}} on SimplexD',
    bodyText:
      'Hello,\n\n{{inviterName}} invited you to join {{organizationName}} as {{role}}.\n\nAccept: {{inviteUrl}}\n\nThis invitation expires on {{expiresAt}}.',
    variables: ['inviterName', 'organizationName', 'role', 'inviteUrl', 'expiresAt'],
  },
  {
    key: 'admin_setup',
    channel: 'email',
    subject: 'Complete your SimplexD administrator setup',
    bodyText:
      'Complete the first administrator setup: {{setupUrl}}\n\nThis link expires on {{expiresAt}}.',
    variables: ['setupUrl', 'expiresAt'],
  },
  {
    key: 'otp',
    channel: 'sms',
    bodyText: 'SimplexD code: {{code}}. Expires in {{expiresIn}}. Never share this code.',
    variables: ['code', 'expiresIn'],
  },
  {
    key: 'test_message',
    channel: 'sms',
    bodyText: 'SimplexD test message from {{environment}} at {{sentAt}}.',
    variables: ['environment', 'sentAt'],
  },
  {
    key: 'test_message',
    channel: 'email',
    subject: 'SimplexD SMTP test',
    bodyText: 'This is a test email from SimplexD ({{environment}}) sent at {{sentAt}}.',
    variables: ['environment', 'sentAt'],
  },
];
