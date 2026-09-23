/**
 * Service registry: the eight core services and the expansion portfolio.
 * Expansions are feature-flagged workflow templates that share the engagement
 * pipeline, tasks, evidence, billing and audit infrastructure.
 */

export const CORE_SERVICE_SLUGS = [
  'construction-monitoring',
  'due-diligence',
  'architectural-services',
  'property-management',
  'virtual-inspections',
  'purchase-support',
  'property-search',
  'land-sales-leasing',
] as const;
export type CoreServiceSlug = (typeof CORE_SERVICE_SLUGS)[number];

export const WORKFLOW_TEMPLATE_KEYS = [
  'construction_monitoring',
  'due_diligence',
  'architecture',
  'property_management',
  'virtual_inspection',
  'purchase_support',
  'property_search',
  'land_sales_leasing',
  'contractor_tendering',
  'materials_procurement',
  'quantity_surveying',
  'snagging',
  'renovation',
  'preventive_maintenance',
  'estate_management',
  'rental_placement',
  'student_housing',
  'short_stay',
  'commercial_property',
  'landowner_matching',
  'investment_feasibility',
  'energy_water',
  'referrals',
  'valuation_referral',
  'portfolio_reporting',
  'diaspora_concierge',
  'partner_network',
  'market_intelligence',
  'dispute_support',
  'document_renewals',
  'ai_assist',
] as const;
export type WorkflowTemplateKey = (typeof WORKFLOW_TEMPLATE_KEYS)[number];

export interface WorkflowTemplate {
  key: WorkflowTemplateKey;
  /** Which shared modules the workflow activates in the portal. */
  modules: Array<
    | 'project'
    | 'reports'
    | 'evidence'
    | 'tasks'
    | 'quotes'
    | 'invoices'
    | 'tenders'
    | 'procurement'
    | 'leases'
    | 'work_orders'
    | 'listings'
    | 'shortlist'
    | 'appointments'
    | 'data_room'
    | 'referral'
    | 'scenario'
  >;
  /** Payment required before work starts (policy default; quote may override). */
  paymentBeforeWork: boolean;
  /** Intake checklist keys required at request creation. */
  intake: string[];
  /** Completion evidence required to move to delivered. */
  completionEvidence: string[];
  /** Regulated features that this template may never enable. */
  neverEnables?: string[];
}

export const WORKFLOW_TEMPLATES: Record<WorkflowTemplateKey, WorkflowTemplate> = {
  construction_monitoring: {
    key: 'construction_monitoring',
    modules: ['project', 'reports', 'evidence', 'tasks', 'quotes', 'invoices', 'appointments'],
    paymentBeforeWork: true,
    intake: ['property', 'project_stage', 'drawings_or_boq', 'site_access'],
    completionEvidence: ['reviewed_report', 'unresolved_issues_list', 'milestone_acceptance'],
  },
  due_diligence: {
    key: 'due_diligence',
    modules: ['reports', 'evidence', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['property', 'title_documents', 'seller_contact'],
    completionEvidence: ['decision_memorandum', 'named_reviewer', 'scope_limitations'],
  },
  architecture: {
    key: 'architecture',
    modules: ['project', 'reports', 'evidence', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['brief', 'site_information', 'budget_range'],
    completionEvidence: ['signed_off_deliverable', 'revision_history'],
  },
  property_management: {
    key: 'property_management',
    modules: ['leases', 'work_orders', 'invoices', 'reports', 'evidence', 'tasks'],
    paymentBeforeWork: false,
    intake: ['property', 'units', 'existing_leases'],
    completionEvidence: ['reconciled_statement', 'open_obligations'],
  },
  virtual_inspection: {
    key: 'virtual_inspection',
    modules: ['appointments', 'reports', 'evidence', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['property', 'access_contact', 'checklist_focus'],
    completionEvidence: ['reviewed_inspection_report'],
  },
  purchase_support: {
    key: 'purchase_support',
    modules: ['shortlist', 'tasks', 'evidence', 'quotes', 'invoices', 'reports'],
    paymentBeforeWork: false,
    intake: ['search_criteria', 'budget', 'fee_basis_agreement'],
    completionEvidence: ['approved_closing_pack', 'agreed_fee_basis'],
  },
  property_search: {
    key: 'property_search',
    modules: ['shortlist', 'appointments', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['requirements', 'budget', 'locations'],
    completionEvidence: ['accepted_shortlist_or_outcome'],
  },
  land_sales_leasing: {
    key: 'land_sales_leasing',
    modules: ['listings', 'evidence', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: false,
    intake: ['owner_authority', 'parcel', 'title_disclosures'],
    completionEvidence: ['authorized_listing', 'documented_outcome'],
  },
  contractor_tendering: {
    key: 'contractor_tendering',
    modules: ['tenders', 'project', 'evidence', 'tasks', 'invoices'],
    paymentBeforeWork: true,
    intake: ['scope_or_boq', 'evaluation_weights', 'timeline'],
    completionEvidence: ['award_record', 'evaluation_summary'],
  },
  materials_procurement: {
    key: 'materials_procurement',
    modules: ['procurement', 'evidence', 'tasks', 'invoices'],
    paymentBeforeWork: true,
    intake: ['material_list', 'delivery_location'],
    completionEvidence: ['delivery_evidence', 'discrepancy_closure'],
  },
  quantity_surveying: {
    key: 'quantity_surveying',
    modules: ['project', 'reports', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['drawings', 'scope'],
    completionEvidence: ['versioned_estimate'],
  },
  snagging: {
    key: 'snagging',
    modules: ['appointments', 'reports', 'evidence', 'tasks', 'invoices'],
    paymentBeforeWork: true,
    intake: ['property', 'handover_date'],
    completionEvidence: ['defects_closed_or_documented'],
  },
  renovation: {
    key: 'renovation',
    modules: ['project', 'tenders', 'reports', 'evidence', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['property', 'condition_survey'],
    completionEvidence: ['reviewed_report', 'milestone_acceptance'],
  },
  preventive_maintenance: {
    key: 'preventive_maintenance',
    modules: ['work_orders', 'evidence', 'invoices', 'reports'],
    paymentBeforeWork: false,
    intake: ['asset_register'],
    completionEvidence: ['sla_report'],
  },
  estate_management: {
    key: 'estate_management',
    modules: ['leases', 'work_orders', 'invoices', 'reports', 'evidence'],
    paymentBeforeWork: false,
    intake: ['estate', 'service_charge_policy'],
    completionEvidence: ['estate_statement'],
  },
  rental_placement: {
    key: 'rental_placement',
    modules: ['listings', 'appointments', 'leases', 'evidence', 'invoices'],
    paymentBeforeWork: false,
    intake: ['property', 'unit', 'screening_consent'],
    completionEvidence: ['signed_lease', 'move_in_inventory'],
  },
  student_housing: {
    key: 'student_housing',
    modules: ['leases', 'work_orders', 'invoices', 'reports'],
    paymentBeforeWork: false,
    intake: ['property', 'bed_inventory', 'academic_calendar'],
    completionEvidence: ['reconciled_statement'],
  },
  short_stay: {
    key: 'short_stay',
    modules: ['leases', 'tasks', 'invoices', 'reports'],
    paymentBeforeWork: false,
    intake: ['property', 'calendar'],
    completionEvidence: ['owner_statement'],
  },
  commercial_property: {
    key: 'commercial_property',
    modules: ['shortlist', 'leases', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['requirements', 'fit_out', 'compliance_checklist'],
    completionEvidence: ['documented_outcome'],
  },
  landowner_matching: {
    key: 'landowner_matching',
    modules: ['data_room', 'tasks', 'quotes', 'invoices'],
    paymentBeforeWork: false,
    intake: ['opportunity_profile', 'conflict_disclosure'],
    completionEvidence: ['adviser_review'],
    neverEnables: ['regulated.pooled_investment', 'regulated.fractional_ownership'],
  },
  investment_feasibility: {
    key: 'investment_feasibility',
    modules: ['scenario', 'reports', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['saved_scenario'],
    completionEvidence: ['reviewed_feasibility_report'],
  },
  energy_water: {
    key: 'energy_water',
    modules: ['project', 'procurement', 'evidence', 'quotes', 'invoices'],
    paymentBeforeWork: true,
    intake: ['load_survey'],
    completionEvidence: ['installation_evidence', 'warranty'],
  },
  referrals: {
    key: 'referrals',
    modules: ['referral', 'tasks'],
    paymentBeforeWork: false,
    intake: ['consent', 'documents'],
    completionEvidence: ['status_tracked'],
    neverEnables: ['regulated.lending', 'regulated.escrow_custody'],
  },
  valuation_referral: {
    key: 'valuation_referral',
    modules: ['referral', 'reports', 'invoices'],
    paymentBeforeWork: true,
    intake: ['purpose', 'property'],
    completionEvidence: ['valuer_report'],
  },
  portfolio_reporting: {
    key: 'portfolio_reporting',
    modules: ['reports', 'invoices'],
    paymentBeforeWork: false,
    intake: ['portfolio'],
    completionEvidence: ['exported_report'],
  },
  diaspora_concierge: {
    key: 'diaspora_concierge',
    modules: ['tasks', 'appointments', 'reports', 'invoices'],
    paymentBeforeWork: false,
    intake: ['time_zone', 'delegates'],
    completionEvidence: ['sla_report'],
  },
  partner_network: {
    key: 'partner_network',
    modules: ['tasks'],
    paymentBeforeWork: false,
    intake: ['credentials', 'coverage'],
    completionEvidence: ['verification_record'],
  },
  market_intelligence: {
    key: 'market_intelligence',
    modules: ['scenario', 'reports'],
    paymentBeforeWork: false,
    intake: ['subscription'],
    completionEvidence: ['methodology_note'],
  },
  dispute_support: {
    key: 'dispute_support',
    modules: ['evidence', 'tasks', 'referral'],
    paymentBeforeWork: false,
    intake: ['chronology'],
    completionEvidence: ['referral_record'],
    neverEnables: ['regulated.automated_legal_certification'],
  },
  document_renewals: {
    key: 'document_renewals',
    modules: ['tasks', 'evidence', 'invoices'],
    paymentBeforeWork: false,
    intake: ['documents', 'expiry_dates'],
    completionEvidence: ['renewed_document'],
  },
  ai_assist: {
    key: 'ai_assist',
    modules: ['reports'],
    paymentBeforeWork: false,
    intake: ['opt_in'],
    completionEvidence: ['human_review'],
  },
};

export const REGULATED_FLAG_KEYS = [
  'regulated.pooled_investment',
  'regulated.fractional_ownership',
  'regulated.customer_wallet',
  'regulated.escrow_custody',
  'regulated.lending',
  'regulated.automated_legal_certification',
] as const;

export function featureFlagKeyFor(template: WorkflowTemplateKey): string | null {
  const core: WorkflowTemplateKey[] = [
    'construction_monitoring',
    'due_diligence',
    'architecture',
    'property_management',
    'virtual_inspection',
    'purchase_support',
    'property_search',
    'land_sales_leasing',
  ];
  return core.includes(template) ? null : `expansion.${template}`;
}

export function referenceFor(prefix: string, sequence: number, year: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}
