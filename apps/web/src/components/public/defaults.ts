/**
 * Default public copy used when the CMS has not published a page yet.
 * Everything here is a factual product description derived from the build
 * brief: no marketing statistics, testimonials, partner badges, nationwide
 * availability or project claims (brand assets are not yet approved).
 */

export const SITE = {
  name: 'SimplexD',
  tagline: 'Property services and oversight for Nigerians at home and abroad.',
  description:
    'SimplexD coordinates construction monitoring, due diligence, architectural services, property management, virtual inspections, purchase representation, property search and land transactions in Nigeria, with dated evidence, named reviewers and clear next actions.',
} as const;

export const HERO = {
  eyebrow: 'Nigerian property services with verifiable evidence',
  title: 'See what was checked, by whom and when, before you decide.',
  body: 'SimplexD runs eight property services in Nigeria for owners who cannot be on site every day. Every engagement moves through a scoped quotation, work with captured evidence and a reviewed delivery, and every location figure on this site carries its source and date.',
  primary: { label: 'Explore where to build', href: '/explore' },
  secondary: { label: 'Book a consultation', href: '/book' },
  points: [
    'Reports state their scope, limitations and named reviewer.',
    'Price anchors state their basis; percentage fees need an agreed basis and signed scope.',
    'Map coverage and actual service availability are shown as separate facts.',
  ],
} as const;

export type GoalKey =
  'buy_safely' | 'build_with_oversight' | 'manage_property' | 'invest_and_compare';

export interface GoalPath {
  key: GoalKey;
  title: string;
  description: string;
  href: string;
  exploreHref: string;
  serviceSlugs: string[];
}

export const GOAL_PATHS: GoalPath[] = [
  {
    key: 'buy_safely',
    title: 'Buy safely',
    description:
      'Title and document checks, a decision memorandum with named reviewer, then representation through offers and closing.',
    href: '/services?goal=buy_safely',
    exploreHref: '/explore?objective=owner_occupation',
    serviceSlugs: ['due-diligence', 'purchase-support', 'property-search'],
  },
  {
    key: 'build_with_oversight',
    title: 'Build with oversight',
    description:
      'A design brief with versioned drawings, then independent monitoring with site visits, captured evidence and milestone acceptance.',
    href: '/services?goal=build_with_oversight',
    exploreHref: '/explore?objective=development_for_sale',
    serviceSlugs: ['architectural-services', 'construction-monitoring'],
  },
  {
    key: 'manage_property',
    title: 'Manage my property',
    description:
      'Leases, rent schedules, collections, maintenance and owner statements that reconcile, with inspections you can watch remotely.',
    href: '/services?goal=manage_property',
    exploreHref: '/explore?objective=long_term_rent',
    serviceSlugs: ['property-management', 'virtual-inspections'],
  },
  {
    key: 'invest_and_compare',
    title: 'Invest and compare',
    description:
      'Compare up to four locations on evidence with visible units, dates and confidence; save a scenario and request local verification.',
    href: '/explore?objective=long_term_rent',
    exploreHref: '/explore?objective=long_term_rent',
    serviceSlugs: ['property-search', 'due-diligence', 'land-sales-leasing'],
  },
];

export const GOAL_LABELS: Record<GoalKey | 'other', string> = {
  buy_safely: 'Buy safely',
  build_with_oversight: 'Build with oversight',
  manage_property: 'Manage my property',
  invest_and_compare: 'Invest and compare',
  other: 'Something else',
};

export interface WorkflowStep {
  key: string;
  title: string;
  description: string;
}

export const HOW_IT_WORKS_STEPS: WorkflowStep[] = [
  {
    key: 'inquiry',
    title: 'Inquiry',
    description:
      'You describe the property, the goal and any locations or scenarios you explored. Nothing is repeated later: the request carries them.',
  },
  {
    key: 'triage',
    title: 'Triage',
    description:
      'The team confirms the service fits, checks service availability for the location and asks only for what the scope needs.',
  },
  {
    key: 'quotation',
    title: 'Scoped quotation',
    description:
      'A versioned quotation states scope, exclusions, price basis and validity. Percentage fees are never calculated without an agreed basis and signed scope.',
  },
  {
    key: 'acceptance',
    title: 'Acceptance and payment where required',
    description:
      'You accept a specific quotation version. Where the service requires payment before work, an invoice is issued and paid through hosted checkout once the gateway is configured.',
  },
  {
    key: 'work',
    title: 'Assigned work with evidence',
    description:
      'Named staff or vetted partners carry out the work. Photos, video and documents record capture time, uploader and checksum separately from server receipt time.',
  },
  {
    key: 'delivery',
    title: 'Reviewed delivery',
    description:
      'A reviewer other than the author approves the deliverable before release. You confirm completion or request rework; feedback is recorded.',
  },
];

export interface SampleReport {
  title: string;
  serviceSlug: string;
  contains: string[];
}

export const SAMPLE_REPORTS: SampleReport[] = [
  {
    title: 'Site visit progress report',
    serviceSlug: 'construction-monitoring',
    contains: [
      'Visit date, inspector and the milestone plan the visit was checked against',
      'Checklist results with photos and video, each stamped with capture time and uploader',
      'Defects and material checks with severity and the party accountable',
      'Budget commitments and actuals against the approved version',
      "Inspector's progress estimate shown separately from your milestone approval",
      'Unresolved issues carried forward and the report version history',
    ],
  },
  {
    title: 'Due diligence decision memorandum',
    serviceSlug: 'due-diligence',
    contains: [
      'Scope and limitations of the review and the named professional reviewer',
      'Document checklist with what was received, what was verified and what is outstanding',
      'Survey references and site findings with dates',
      'Queries raised, answers received and red flags',
      'A decision memorandum with evidence references; no automatic legal guarantee',
    ],
  },
  {
    title: 'Virtual inspection report',
    serviceSlug: 'virtual-inspections',
    contains: [
      'Appointment details in Africa/Lagos and your own time zone',
      'Checklist items with photos, video and annotated findings',
      'Defect severity and recommended next actions',
      'Reviewer approval before release and a downloadable export',
    ],
  },
];

export const SAMPLE_REPORTS_NOTE =
  'Sample documents are published only after an owner grants redaction and publication rights. Until then, this list describes exactly what each report contains.';

export interface FaqItem {
  question: string;
  answerHtml: string;
  answerText: string;
}

function faq(question: string, answerText: string): FaqItem {
  return { question, answerText, answerHtml: `<p>${answerText}</p>` };
}

export const DEFAULT_FAQS: FaqItem[] = [
  faq(
    'What does SimplexD do, and what does it not do?',
    'SimplexD coordinates eight property services in Nigeria: construction monitoring, due diligence, architectural services, property management, virtual inspections, purchase representation, property search and land sales or leasing. It does not certify legal title automatically, guarantee valuations, pool investments, hold customer funds, provide escrow or lend money. Diligence memoranda are professional opinions with named reviewers.',
  ),
  faq(
    'How do I know the evidence in a report is real?',
    'Each photo, video or document records its capture time, uploader and checksum, and optional GPS, separately from the time the server received it. EXIF and GPS data are user-provided evidence, not proof of authenticity, so a reviewer other than the author checks findings before a report is released, and every report keeps its version history.',
  ),
  faq(
    'How is pricing decided?',
    'Each service shows an indicative price anchor with its basis, minimum scope, exclusions and effective date. Anchors still under business review are labelled instead of shown as figures. Your engagement is priced by a scoped quotation after triage. Percentage-based fees are calculated only on an agreed percentage basis with a signed scope.',
  ),
  faq(
    'I live outside Nigeria. How do time zones and approvals work?',
    'Appointments are shown in Africa/Lagos and in your own time zone, and consultation requests capture your time zone and preferred days. Household members or advisers can be invited with explicit view, comment or approval rights. Calendar-scheduled consultations with Google Meet invitations become available once the team configures the calendar integration.',
  ),
  faq(
    'Does a location on the map mean SimplexD operates there?',
    'No. Map coverage and service availability are separate facts. Every location page shows its service coverage status per service, its evidence with sources and dates, and what evidence is still missing. Unknown flood or title status is never presented as low risk.',
  ),
  faq(
    'How do payments work?',
    'Invoices are paid through hosted checkout once the payment gateway is configured, or by a declared bank transfer that finance confirms before it counts as paid. There are no customer wallets and no escrow badge for ordinary gateway payments. Receipts and payment status are visible in the customer portal.',
  ),
];

export const ABOUT_DEFAULT = {
  title: 'About SimplexD',
  intro:
    'SimplexD is a Nigerian property services and oversight platform for owners who live abroad or are too busy to be on site. It exists so that decisions about land, buildings and tenancies rest on dated evidence rather than assurances.',
  sections: [
    {
      heading: 'What the platform does',
      body: 'Eight services share one engagement pipeline: inquiry, triage, scoped quotation, acceptance, invoice and payment where required, assigned work, evidence and review, delivery, completion and feedback. Customers use a portal to request services, accept quotations, approve change orders, read released reports and manage appointments. Staff operate the business from an admin console; contractors and professionals work in a restricted partner workspace.',
    },
    {
      heading: 'Evidence standards',
      body: 'Location data on this site is labelled with one of eight evidence badges rather than a single generic "verified" label. Observations keep their source, retrieval date, observation period, sample size and geographic scope. Statewide figures are labelled as statewide context, never presented as city values. Financial ranking stays switched off for a location until locally applicable cost and rental inputs meet the coverage policy.',
    },
    {
      heading: 'What is not claimed',
      body: 'This site carries no marketing statistics, testimonials, partner badges or project claims until owners grant publication rights and evidence exists. Map coverage does not imply a staffed operation in that location: service availability is confirmed per location and per service.',
    },
    {
      heading: 'Brand and content',
      body: 'Approved brand assets and photography are being obtained from the business owner; placeholder illustrations are used in the meantime.',
    },
  ],
} as const;

export const DIASPORA_DEFAULT = {
  title: 'For Nigerians abroad',
  intro:
    'Owning or building property in Nigeria from another country means relying on people you cannot watch. SimplexD is built so you can rely on records instead.',
  capabilities: [
    {
      heading: 'Time-zone-aware coordination',
      body: 'Consultation requests capture your time zone and preferred days. Appointments are shown in Africa/Lagos and in your zone, and reminders follow your quiet hours.',
    },
    {
      heading: 'Evidence digests',
      body: 'Released reports, site-visit media and budget changes appear in your portal with what changed, what needs you and what happens next, so you review a digest rather than a stream of chat messages.',
    },
    {
      heading: 'Delegated approvals',
      body: 'Invite a family member or adviser with explicit view, comment or approval rights. Milestone approvals, change orders and quotation acceptances record who decided and when.',
    },
    {
      heading: 'Documents only when needed',
      body: 'Identity documents are requested only when a chosen transaction requires them, and private files are served through time-limited signed links after malware scanning.',
    },
  ],
  availabilityNote:
    'Consultation requests and the location explorer are open now. Portal features become available to customers as each release wave completes; your consultation reply states what applies to your engagement.',
} as const;

export const LOCAL_DEFAULT = {
  title: 'For owners and professionals in Nigeria',
  intro:
    'You may be in Lagos, Abuja or Port Harcourt and still unable to visit a site in Ibadan every week. SimplexD gives busy local owners the same evidence trail as customers abroad.',
  capabilities: [
    {
      heading: 'Scheduled visits with evidence',
      body: 'Monitoring and inspection visits follow a milestone plan and checklist. Photos and video record capture time and uploader so you can review progress between your own visits.',
    },
    {
      heading: 'Reconciled statements',
      body: 'Property management delivers period statements that reconcile rent schedules, collections, arrears and maintenance spend, with open obligations listed.',
    },
    {
      heading: 'Delegated approvals',
      body: 'Family members, partners or advisers can be given view, comment or approval rights on a property or project without seeing your entire portfolio.',
    },
    {
      heading: 'Local payments',
      body: 'Invoices are paid in naira through hosted checkout once the gateway is configured, or by declared bank transfer confirmed by finance.',
    },
  ],
  availabilityNote:
    'Consultation requests and the location explorer are open now. Portal features become available to customers as each release wave completes; your consultation reply states what applies to your engagement.',
} as const;

export const BOOK_DEFAULT = {
  title: 'Request a consultation',
  intro:
    'Tell us what you own, what you plan and where. A member of the team replies by email to confirm scope and a time.',
  schedulingNote:
    'Calendar-scheduled consultations with Google Meet invitations become available once the SimplexD team configures the Google Calendar integration. Until then, share your preferred days and times and your time zone below; the team confirms a slot by email.',
} as const;

export const CONTACT_FALLBACK = 'Contact details are being confirmed by the SimplexD team.';

export const POLICY_TEMPLATE_NOTICE =
  'This page is a template pending legal review. It describes the intended practice and is not yet a reviewed legal document.';

export const DEFAULT_POLICIES: Record<'privacy' | 'terms', { title: string; markdown: string }> = {
  privacy: {
    title: 'Privacy notice',
    markdown: `## What this notice covers

SimplexD processes personal data to respond to inquiries, run property service engagements, operate the customer portal and meet legal and accounting obligations. This template will be reviewed against the Nigeria Data Protection Act 2023 and the laws of the customer's country of residence before publication.

## Data we collect

- Contact details you provide in forms: name, email, optional phone number, country of residence and time zone.
- Engagement records: property details, documents you upload, quotations, invoices and messages.
- Consent records: the choice you made, the policy version and when it was recorded.
- Technical data: a hashed IP address and user agent for abuse control and, only with your consent, analytics events without personal identifiers.

## How we use it

- To reply to your request and deliver the services you accept.
- To keep an audit trail of decisions such as quotation acceptance and milestone approval.
- To send marketing email only when you have opted in; you can withdraw at any time.

## Retention and deletion

Evidence linked to financial or legal records is retained for the period the business is required to keep it. A deletion request is honoured for everything else; where restricted retention applies, we tell you what is kept and why.

## Your rights

You can request access, correction, export or deletion of your data through your portal settings or by contacting the team using the details on the contact page.`,
  },
  terms: {
    title: 'Terms of service',
    markdown: `## Scope

These terms govern the use of the SimplexD website and customer portal and the property services described on the services pages. This template is pending legal review.

## Engagements

Each service engagement is defined by a scoped quotation that states deliverables, exclusions, price basis and validity. Work starts after acceptance and, where stated, after payment. Percentage-based fees apply only on an agreed basis with a signed scope.

## Evidence and reports

Reports are professional deliverables with named reviewers and stated limitations. They do not constitute legal certification, a guaranteed valuation or investment advice. Calculators and location comparisons are scenarios based on stated inputs and evidence badges.

## Payments

Invoices are payable in naira through the hosted checkout of the configured payment gateway or by bank transfer confirmed by finance. SimplexD does not hold customer funds, operate wallets or provide escrow.

## Listings and content

Property listings are published only after owner authority and content moderation. A verification badge states exactly what was checked, by whom and when, with an expiry.

## Accounts and access

You are responsible for the people you invite to your organisation and the rights you grant them. Access can be revoked at any time and takes effect immediately.`,
  },
};

export const EVIDENCE_STATEMENTS: string[] = [
  'A source retrieval date is not the date the market was measured; both are shown.',
  'Statewide or regional figures are labelled as context and never presented as city values.',
  'Supplier facility references are research leads, not verified delivery routes or dealer quotes.',
  'Unknown flood or title status is shown as unknown, never as low risk.',
  'Financial ranking requires locally applicable cost and rental inputs and at least 70% weighted coverage; below that, the site says "more local data needed".',
];

export const EXPANSION_NOTE =
  'Planned services are workflow templates that share the same engagement, evidence, billing and audit infrastructure. They are activated in release waves and stay unavailable for booking until staffed; you can register interest so the team can tell you when a service opens.';
