import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import * as s from '../schema';
import { applyActorContext, systemContext } from '../tenant';

/**
 * Starter configuration: one report template per core report kind and the
 * document requirements for the eight core services. Idempotent and
 * non-destructive: a report kind that already has any template, or a service
 * that already has any requirement (active or not), is left alone, so edits
 * made in the admin console are never overwritten by a re-run.
 *
 * The wording is deliberately generic and editable. It makes no legal,
 * structural or title guarantee: every report states its scope and limits.
 */

type ReportKind = (typeof s.reportKindEnum.enumValues)[number];
type EngagementStage = (typeof s.engagementStatusEnum.enumValues)[number];

const COMMON_LIMITATIONS = `This report records what the named reviewer observed, and the documents and evidence listed in it, on the dates stated. It is not a legal opinion, title guarantee, structural certification, valuation or warranty, and it does not replace advice from a qualified lawyer, surveyor, engineer or valuer where one is needed.

Photos, videos, measurements and location data are evidence supplied at capture time. Timestamps and GPS readings are recorded as provided and are not proof of authenticity on their own. Conditions can change after the dates in this report.

Ask your project manager about anything unclear before you rely on this report for a decision.`;

export const reportTemplateDefaults: Array<{
  kind: ReportKind;
  name: string;
  sections: s.ReportTemplateSection[];
  limitationsMarkdown: string;
}> = [
  {
    kind: 'progress',
    name: 'Construction progress report',
    sections: [
      {
        key: 'summary',
        heading: 'Summary',
        guidance: 'What changed since the last report, in plain words, and anything that needs the owner.',
        required: true,
      },
      {
        key: 'visit_details',
        heading: 'Visit details',
        guidance: 'Date and time on site, who attended, weather and any access limits.',
        required: true,
      },
      {
        key: 'progress_against_plan',
        heading: 'Progress against the milestone plan',
        guidance:
          "Each milestone's observed status. Your progress estimate is not the customer's milestone acceptance.",
        required: true,
      },
      {
        key: 'budget_position',
        heading: 'Budget, commitments and actuals',
        guidance: 'Refer to recorded commitments and actuals only; do not estimate figures.',
        required: false,
      },
      {
        key: 'materials',
        heading: 'Materials checks',
        guidance: 'Deliveries seen, quantities checked and any quality concerns.',
        required: false,
      },
      {
        key: 'defects',
        heading: 'Defects and quality issues',
        guidance: 'New and unresolved defects with severity and who is responsible.',
        required: true,
      },
      {
        key: 'change_orders',
        heading: 'Change orders and approvals',
        required: false,
      },
      {
        key: 'next_steps',
        heading: 'Next steps and decisions needed',
        required: true,
      },
      {
        key: 'evidence_index',
        heading: 'Evidence index',
        guidance: 'Photos, videos and documents referenced, with capture times.',
        required: true,
      },
    ],
    limitationsMarkdown: `${COMMON_LIMITATIONS}

Progress percentages are the inspector's observation on the visit date. They are not a certificate of completion, a payment authorisation or the owner's acceptance of a milestone.`,
  },
  {
    kind: 'inspection',
    name: 'Property inspection report',
    sections: [
      { key: 'summary', heading: 'Summary', required: true },
      {
        key: 'scope',
        heading: 'Scope of this inspection',
        guidance: 'What was agreed to be inspected and anything excluded.',
        required: true,
      },
      {
        key: 'property_and_access',
        heading: 'Property and access',
        guidance: 'Address as provided, areas accessed and areas that could not be accessed.',
        required: true,
      },
      { key: 'findings', heading: 'Findings by area', required: true },
      {
        key: 'defects',
        heading: 'Defects and severity',
        guidance: 'Use the agreed severity scale; say what was seen, not what is assumed.',
        required: true,
      },
      { key: 'recommendations', heading: 'Recommended next steps', required: true },
      { key: 'evidence_index', heading: 'Evidence index', required: true },
    ],
    limitationsMarkdown: `${COMMON_LIMITATIONS}

The inspection was visual and non-invasive unless stated otherwise. Hidden, covered or inaccessible parts were not inspected.`,
  },
  {
    kind: 'virtual_inspection',
    name: 'Virtual inspection report',
    sections: [
      { key: 'summary', heading: 'Summary', required: true },
      {
        key: 'session_details',
        heading: 'Session details',
        guidance: 'Date, time, platform, participants and who operated the camera.',
        required: true,
      },
      {
        key: 'areas_covered',
        heading: 'Areas covered and not covered',
        required: true,
      },
      { key: 'findings', heading: 'Findings', required: true },
      {
        key: 'defects',
        heading: 'Annotated defects and severity',
        required: false,
      },
      {
        key: 'remote_limits',
        heading: 'What a remote inspection could not check',
        guidance: 'For example smells, moisture, hidden structure or anything off camera.',
        required: true,
      },
      { key: 'recommendations', heading: 'Recommended next steps', required: true },
      { key: 'evidence_index', heading: 'Evidence index', required: true },
    ],
    limitationsMarkdown: `${COMMON_LIMITATIONS}

A virtual inspection shows only what the camera showed during the session. It cannot confirm anything that was not visible, and an in-person inspection may find more.`,
  },
  {
    kind: 'diligence_memo',
    name: 'Due diligence decision memorandum',
    sections: [
      {
        key: 'summary',
        heading: 'Summary and decision points',
        guidance: 'The questions the customer must decide on, in plain words.',
        required: true,
      },
      { key: 'property_identification', heading: 'Property identification', required: true },
      {
        key: 'documents_reviewed',
        heading: 'Documents reviewed',
        guidance: 'List each document with its reference and whether it was an original or copy.',
        required: true,
      },
      { key: 'survey_references', heading: 'Survey references', required: false },
      {
        key: 'searches',
        heading: 'Searches and enquiries made',
        guidance: 'Where, when and by whom; record results exactly as received.',
        required: true,
      },
      { key: 'site_findings', heading: 'Site findings', required: false },
      { key: 'open_queries', heading: 'Open queries', required: false },
      { key: 'red_flags', heading: 'Red flags', required: true },
      {
        key: 'professional_review',
        heading: 'Named reviewer and basis of review',
        guidance: 'Who reviewed the findings and in what professional capacity.',
        required: true,
      },
      { key: 'next_steps', heading: 'Recommended next steps', required: true },
    ],
    limitationsMarkdown: `${COMMON_LIMITATIONS}

This memorandum summarises the checks listed above. It is not a guarantee of title or of the absence of claims, and search results depend on the records made available on the dates shown. Take independent legal advice before paying for or signing for a property.`,
  },
  {
    kind: 'closing_pack',
    name: 'Purchase closing pack',
    sections: [
      { key: 'summary', heading: 'Transaction summary', required: true },
      {
        key: 'agreed_terms',
        heading: 'Agreed terms and fee basis',
        guidance: 'Reference the signed scope and agreed fee basis.',
        required: true,
      },
      {
        key: 'conditions',
        heading: 'Conditions and how each was satisfied',
        required: true,
      },
      {
        key: 'diligence_status',
        heading: 'Due diligence status',
        guidance: 'Reference the diligence memorandum and any items still open.',
        required: true,
      },
      { key: 'payments', heading: 'Payments and receipts referenced', required: false },
      { key: 'documents_handed_over', heading: 'Documents handed over', required: true },
      {
        key: 'outstanding_items',
        heading: 'Outstanding items and who is responsible',
        required: true,
      },
    ],
    limitationsMarkdown: `${COMMON_LIMITATIONS}

This pack records the documents and steps listed as at the handover date. It does not certify title or registration, which remain with the relevant registry and your legal adviser.`,
  },
  {
    kind: 'search_outcome',
    name: 'Property search outcome',
    sections: [
      { key: 'summary', heading: 'Summary', required: true },
      { key: 'requirements', heading: 'Your requirements', required: true },
      {
        key: 'search_activity',
        heading: 'Search activity',
        guidance: 'Sources checked, listings reviewed and viewings held.',
        required: true,
      },
      { key: 'shortlist', heading: 'Shortlist comparison', required: true },
      { key: 'viewing_feedback', heading: 'Viewing feedback', required: false },
      {
        key: 'outcome',
        heading: 'Outcome and recommendation',
        guidance: 'The accepted shortlist, or the documented reason the search ended.',
        required: true,
      },
    ],
    limitationsMarkdown: `${COMMON_LIMITATIONS}

Listing details, availability and prices come from sellers, landlords or agents and can change without notice. Shortlisting a property is not a check of its title; order due diligence before you commit.`,
  },
];

interface RequirementSeed {
  name: string;
  description: string;
  stage: EngagementStage | null;
  required: boolean;
  sensitive?: boolean;
}

const IDENTITY_NOTE =
  'Requested only because this step of the transaction needs it; only the people working on your request can open it.';

/** Keyed by core service slug. Descriptions say why a document is asked for; all are editable. */
export const documentRequirementDefaults: Record<string, RequirementSeed[]> = {
  'construction-monitoring': [
    {
      name: 'Approved building drawings',
      description: 'Architectural and structural drawings the builder is working from.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Bill of quantities or contractor quotation',
      description: 'Used to set the project baseline and budget.',
      stage: 'triage',
      required: false,
    },
    {
      name: 'Contractor agreement or scope of works',
      description: 'Helps us check progress against what was agreed.',
      stage: 'accepted',
      required: false,
    },
    {
      name: 'Building permit or planning approval, if issued',
      description: 'Lets us track approvals separately from construction progress.',
      stage: 'in_progress',
      required: false,
    },
  ],
  'due-diligence': [
    {
      name: 'Copy of the title document',
      description:
        'For example a Certificate of Occupancy, Deed of Assignment or Governor’s Consent, as provided by the seller.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Copy of the survey plan',
      description: 'Used for survey reference checks.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Seller or agent details and any offer letter',
      description: 'Who is selling and on what terms, so enquiries can be made.',
      stage: 'triage',
      required: false,
    },
    {
      name: 'Letter authorising searches on your behalf',
      description: 'Some registries ask for written authority before a search.',
      stage: 'accepted',
      required: true,
    },
    {
      name: 'Your photo ID, if a registry asks for it',
      description: IDENTITY_NOTE,
      stage: 'in_progress',
      required: false,
      sensitive: true,
    },
  ],
  'architectural-services': [
    {
      name: 'Site survey plan or plot dimensions',
      description: 'The design starts from the plot’s size, shape and orientation.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Design brief',
      description: 'Rooms, style, budget range and anything you already like.',
      stage: 'triage',
      required: false,
    },
    {
      name: 'Photos of the site',
      description: 'Recent photos of the plot and its surroundings.',
      stage: null,
      required: false,
    },
    {
      name: 'Existing drawings, for a renovation or extension',
      description: 'Drawings of the current building, if you have them.',
      stage: 'triage',
      required: false,
    },
  ],
  'property-management': [
    {
      name: 'Proof of ownership or authority to let',
      description: 'We manage a property only for its owner or someone authorised by them.',
      stage: 'accepted',
      required: true,
    },
    {
      name: 'Existing tenancy agreements',
      description: 'Current leases, so rent schedules start from the agreed terms.',
      stage: 'accepted',
      required: false,
    },
    {
      name: 'Rent and deposit history',
      description: 'Payments received and deposits held, so balances start correctly.',
      stage: 'accepted',
      required: false,
    },
    {
      name: 'Owner photo ID for the management agreement',
      description: IDENTITY_NOTE,
      stage: 'accepted',
      required: false,
      sensitive: true,
    },
  ],
  'virtual-inspections': [
    {
      name: 'Access permission from the owner or occupier',
      description: 'Confirms the inspector may enter and film the property.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Floor plan or list of areas to cover',
      description: 'Helps plan the session so nothing you care about is missed.',
      stage: 'triage',
      required: false,
    },
    {
      name: 'Previous inspection reports, if any',
      description: 'Lets us compare with earlier findings.',
      stage: null,
      required: false,
    },
  ],
  'purchase-support': [
    {
      name: 'Details of properties you are considering',
      description: 'Listings, addresses or offer letters you already have.',
      stage: 'triage',
      required: false,
    },
    {
      name: 'Signed scope and agreed fee basis',
      description: 'A percentage fee is never calculated without an agreed basis and signed scope.',
      stage: 'accepted',
      required: true,
    },
    {
      name: 'Proof of funds or financing letter',
      description: 'Sellers may ask for it before accepting an offer. ' + IDENTITY_NOTE,
      stage: 'in_progress',
      required: false,
      sensitive: true,
    },
    {
      name: 'Buyer photo ID and proof of address for the sale documents',
      description: IDENTITY_NOTE,
      stage: 'in_progress',
      required: false,
      sensitive: true,
    },
  ],
  'property-search': [
    {
      name: 'Example listings or preferred areas',
      description: 'Anything that shows what you are looking for.',
      stage: null,
      required: false,
    },
    {
      name: 'Budget confirmation, if a landlord or seller asks for it',
      description: IDENTITY_NOTE,
      stage: 'in_progress',
      required: false,
      sensitive: true,
    },
  ],
  'land-sales-leasing': [
    {
      name: 'Title document for the land',
      description: 'Title disclosures are shown to buyers only as you approve.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Survey plan',
      description: 'Used to confirm the parcel’s boundaries and area.',
      stage: 'triage',
      required: true,
    },
    {
      name: 'Owner authority or power of attorney, if you act for the owner',
      description: 'A listing is published only with verified owner authority.',
      stage: 'triage',
      required: false,
    },
    {
      name: 'Owner photo ID for owner-authority verification',
      description: IDENTITY_NOTE,
      stage: 'triage',
      required: false,
      sensitive: true,
    },
    {
      name: 'Recent photos of the land',
      description: 'Used for the listing after moderation.',
      stage: null,
      required: false,
    },
  ],
};

export interface ConfigurationSeedSummary {
  reportTemplatesInserted: number;
  documentRequirementsInserted: number;
}

export async function seedConfigurationDefaults(
  db: Database,
  actorUserId: string | null = null,
): Promise<ConfigurationSeedSummary> {
  return db.transaction(async (tx) => {
    await applyActorContext(tx, systemContext('seed-configuration'));
    let reportTemplatesInserted = 0;
    let documentRequirementsInserted = 0;

    for (const t of reportTemplateDefaults) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`report_templates:${t.kind}`}))`);
      const existing = await tx
        .select({ id: s.reportTemplates.id })
        .from(s.reportTemplates)
        .where(eq(s.reportTemplates.kind, t.kind))
        .limit(1);
      if (existing.length > 0) continue;
      await tx.insert(s.reportTemplates).values({
        kind: t.kind,
        name: t.name,
        sections: t.sections,
        limitationsMarkdown: t.limitationsMarkdown,
        active: true,
        createdBy: actorUserId,
      });
      reportTemplatesInserted += 1;
    }

    for (const [slug, requirements] of Object.entries(documentRequirementDefaults)) {
      const [service] = await tx
        .select({ id: s.services.id })
        .from(s.services)
        .where(eq(s.services.slug, slug));
      if (!service) continue;
      const existing = await tx
        .select({ id: s.documentRequirements.id })
        .from(s.documentRequirements)
        .where(eq(s.documentRequirements.serviceId, service.id))
        .limit(1);
      if (existing.length > 0) continue;
      await tx.insert(s.documentRequirements).values(
        requirements.map((r, i) => ({
          serviceId: service.id,
          name: r.name,
          description: r.description,
          stage: r.stage,
          required: r.required,
          sensitive: r.sensitive ?? false,
          active: true,
          sortOrder: (i + 1) * 10,
          createdBy: actorUserId,
        })),
      );
      documentRequirementsInserted += requirements.length;
    }
    // Requirements for every service (service_id null) are left for the business to add.
    return { reportTemplatesInserted, documentRequirementsInserted };
  });
}
