import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import * as s from '../schema';
import { applyActorContext, systemContext } from '../tenant';

/**
 * Starter CMS pages. Idempotent: a page is inserted only when its slug is
 * absent, so operator edits and later revisions are never overwritten. Copy is
 * factual product description: no statistics, testimonials or claims of scale.
 * Policy pages are templates that require legal review before launch.
 */

type ContentKind = (typeof s.contentKindEnum.enumValues)[number];

export interface ContentSeed {
  slug: string;
  kind: ContentKind;
  title: string;
  summary: string;
  bodyMarkdown: string;
  fields?: Record<string, unknown>;
  sortOrder?: number;
  seo?: { title?: string; description?: string; noindex?: boolean };
}

const EVIDENCE_BADGES = [
  {
    key: 'sourced_observation',
    label: 'Sourced observation',
    meaning:
      'Read from a named published source with its retrieval date and observation period recorded separately.',
  },
  {
    key: 'verified_operational_record',
    label: 'Verified record',
    meaning:
      'A first-party record checked by SimplexD staff, such as a supplier quotation or a completed site visit.',
  },
  {
    key: 'regional_context',
    label: 'Statewide context',
    meaning:
      'A statewide or regional figure shown for context; it is not presented as a city value.',
  },
  {
    key: 'model_estimate',
    label: 'Model estimate',
    meaning:
      'Computed from your assumptions and published policy bounds; a scenario, not a valuation.',
  },
  {
    key: 'user_assumption',
    label: 'Your assumption',
    meaning:
      'A value you entered for a scenario; it stays labelled as yours everywhere it is used.',
  },
  {
    key: 'unknown',
    label: 'Unknown',
    meaning:
      'No evidence has been collected yet. Unknown is a real value and is never replaced by a guess or a zero.',
  },
  {
    key: 'stale',
    label: 'Stale',
    meaning:
      'Older than the freshness policy for its data type; still inspectable, excluded from default ranking.',
  },
  {
    key: 'disputed',
    label: 'Disputed',
    meaning: 'Under review after a challenge; shown with the dispute note until resolved.',
  },
];

export const contentSeeds: ContentSeed[] = [
  {
    slug: 'about',
    kind: 'page',
    title: 'About SimplexD',
    summary: 'Property services and oversight for Nigerians at home and abroad.',
    sortOrder: 1,
    bodyMarkdown: `## What SimplexD does

SimplexD provides property services and independent oversight for Nigerians at home and abroad. The platform covers eight core services: construction monitoring, due diligence, architectural services, property management, virtual inspections, purchase representation, property search, and land sales and leasing.

## How we work

Every engagement follows the same pipeline: inquiry, triage, a scoped quotation, your acceptance, invoicing where required, assigned work, evidence and review, delivery, completion and feedback. Each step is a recorded state change with a named actor and, where relevant, a reason.

## Evidence first

Reports, site findings and market observations carry their provenance. Photos and documents record who captured them and when; market figures record their source, geographic scope and observation period. Where evidence is missing, the platform says so rather than filling the gap with an estimate.

## Who it is for

Owners building or buying remotely, busy local professionals who want oversight without site visits, households and advisers who share one organisation, and tenants who need a clear view of their own lease.`,
    seo: {
      title: 'About SimplexD',
      description: 'Property services and independent oversight for Nigerians at home and abroad.',
    },
  },
  {
    slug: 'how-it-works',
    kind: 'page',
    title: 'How it works',
    summary: 'From exploring locations to a completed engagement, step by step.',
    sortOrder: 2,
    bodyMarkdown: `## 1. Explore

Compare markets in the location explorer, adjust scoring priorities and save a scenario. Exploration and basic estimates do not require an account. Every figure shows its evidence badge and date.

## 2. Request a service

Sign in, set up your organisation and start a request. A saved scenario can become a request without re-entering your markets, budget or assumptions. Services that are not staffed for booking yet accept an inquiry instead.

## 3. Triage and quotation

The operations team reviews the request, asks follow-up questions in the request notes and issues a versioned quotation with scope, exclusions and validity.

## 4. Acceptance and invoicing

You accept a quotation from the portal. Where a deposit or full payment is required before work starts, an invoice is issued and payment status reflects verified provider confirmations.

## 5. Work, evidence and review

Assigned professionals carry out the work. Evidence is uploaded with capture details, and reports are reviewed by a named reviewer before release.

## 6. Delivery and completion

Released reports, approvals and decisions appear in your portal. You confirm delivery, raise a dispute with a reason, or let the engagement complete after the review window.`,
    seo: {
      title: 'How SimplexD works',
      description: 'From exploring locations to a completed engagement, step by step.',
    },
  },
  {
    slug: 'evidence-standards',
    kind: 'evidence_standard',
    title: 'Evidence standards',
    summary: 'The eight evidence badges and what each one means.',
    sortOrder: 3,
    fields: { badges: EVIDENCE_BADGES },
    bodyMarkdown: `## Why badges instead of one “verified” label

Different kinds of evidence deserve different trust. A single generic label would hide that difference, so every figure, photo and record carries one of eight badges.

${EVIDENCE_BADGES.map((b) => `### ${b.label}\n\n${b.meaning}`).join('\n\n')}

## Related rules

- Retrieval date and observation date are recorded separately.
- A statewide figure is never silently presented as a city value.
- Unknown flood or title status is never treated as low risk.
- Stale records remain inspectable but are excluded from default ranking.`,
    seo: {
      title: 'Evidence standards',
      description: 'The eight evidence badges SimplexD uses and what each one means.',
    },
  },
  {
    slug: 'faq-what-is-a-scenario',
    kind: 'faq',
    title: 'What is a saved scenario?',
    summary: 'Scenarios are comparisons and assumptions, not valuations.',
    sortOrder: 10,
    fields: {
      question: 'What is a saved scenario?',
      answer:
        'A scenario stores the markets you compared, your filters, scoring priorities and calculator assumptions. It is a comparison under your assumptions, not a valuation or investment advice, and it can be turned into a service request.',
    },
    bodyMarkdown:
      'A scenario stores the markets you compared, your filters, scoring priorities and calculator assumptions. It is a comparison under your assumptions, not a valuation or investment advice, and it can be turned into a service request.',
  },
  {
    slug: 'faq-do-i-need-an-account',
    kind: 'faq',
    title: 'Do I need an account to explore?',
    summary: 'Exploration is open; saving and requesting need an account.',
    sortOrder: 11,
    fields: {
      question: 'Do I need an account to explore locations?',
      answer:
        'No. Exploring the map and running basic estimates is open to everyone. An account is needed to save a scenario to your profile, share it privately, request professional validation or start a service.',
    },
    bodyMarkdown:
      'No. Exploring the map and running basic estimates is open to everyone. An account is needed to save a scenario to your profile, share it privately, request professional validation or start a service.',
  },
  {
    slug: 'faq-how-are-prices-set',
    kind: 'faq',
    title: 'How are service prices set?',
    summary: 'Indicative starting prices; final price by quotation.',
    sortOrder: 12,
    fields: {
      question: 'How are service prices set?',
      answer:
        'Published starting prices are indicative and state their basis (fixed, from, per month, percentage or by quotation), minimum scope and exclusions. The final price is always set by a scoped quotation that you accept before work begins. Purchase representation is charged only on an agreed percentage basis with a signed scope.',
    },
    bodyMarkdown:
      'Published starting prices are indicative and state their basis (fixed, from, per month, percentage or by quotation), minimum scope and exclusions. The final price is always set by a scoped quotation that you accept before work begins. Purchase representation is charged only on an agreed percentage basis with a signed scope.',
  },
  {
    slug: 'faq-who-can-see-my-documents',
    kind: 'faq',
    title: 'Who can see my documents?',
    summary: 'Access is scoped to your organisation and explicit grants.',
    sortOrder: 13,
    fields: {
      question: 'Who can see my documents and reports?',
      answer:
        'Members of your organisation according to their role, people you explicitly grant view, comment or approval rights, and the staff and professionals assigned to your engagement. Internal staff notes are never shown to customers. Access is enforced on the server for every query and download, not only in the interface.',
    },
    bodyMarkdown:
      'Members of your organisation according to their role, people you explicitly grant view, comment or approval rights, and the staff and professionals assigned to your engagement. Internal staff notes are never shown to customers. Access is enforced on the server for every query and download, not only in the interface.',
  },
  {
    slug: 'faq-how-do-payments-work',
    kind: 'faq',
    title: 'How do payments work?',
    summary: 'Invoices follow accepted quotations; payments are verified server-side.',
    sortOrder: 14,
    fields: {
      question: 'How do payments work?',
      answer:
        'Invoices are issued after you accept a quotation. Card payments use the payment provider’s hosted checkout, so card details never pass through SimplexD. A payment is only marked successful after the server verifies the provider’s confirmation of reference, amount and currency. Declared bank transfers are confirmed by finance before they count as paid.',
    },
    bodyMarkdown:
      'Invoices are issued after you accept a quotation. Card payments use the payment provider’s hosted checkout, so card details never pass through SimplexD. A payment is only marked successful after the server verifies the provider’s confirmation of reference, amount and currency. Declared bank transfers are confirmed by finance before they count as paid.',
  },
  {
    slug: 'faq-is-a-report-a-legal-guarantee',
    kind: 'faq',
    title: 'Is a due diligence report a legal guarantee?',
    summary: 'Reports are professional opinions with named reviewers and stated limits.',
    sortOrder: 15,
    fields: {
      question: 'Is a due diligence report a legal guarantee?',
      answer:
        'No. A due diligence memorandum is a professional opinion prepared by named professionals with evidence references and explicit scope and limitations. It does not certify title automatically, and unknown title or flood status is reported as unknown rather than as low risk.',
    },
    bodyMarkdown:
      'No. A due diligence memorandum is a professional opinion prepared by named professionals with evidence references and explicit scope and limitations. It does not certify title automatically, and unknown title or flood status is reported as unknown rather than as low risk.',
  },
  {
    slug: 'privacy',
    kind: 'policy',
    title: 'Privacy notice (template pending legal review)',
    summary: 'Template privacy notice; requires legal review before publication to customers.',
    sortOrder: 20,
    fields: {
      reviewStatus: 'template_pending_legal_review',
      effectiveDate: null,
      jurisdiction: 'Nigeria Data Protection Act 2023 and applicable customer jurisdictions',
    },
    bodyMarkdown: `> **Template requiring legal review.** This privacy notice is a draft structure prepared for the SimplexD platform. It has not been reviewed by a lawyer and must not be relied on until the business obtains professional review and sets an effective date.

## What we collect

Account details (name, email, optional phone, time zone), organisation details, the requests and documents you submit, appointment details, payment references (never card numbers), and consent records with their policy version.

## Why we process it

To deliver the services you request, to communicate about your engagements, to meet accounting and legal obligations, and, only with your consent, to send marketing messages.

## Your choices

You can update your profile, notification preferences and marketing consent in the portal at any time. You can request account deletion from Settings; records that must be retained for accounting or legal reasons are kept for the statutory period and the outcome is communicated in writing.

## Retention and security

Evidence linked to financial or legal records is retained for the configured retention period. Access to private documents is checked on the server for every request and download.

## Contact

Contact details for privacy requests are pending owner confirmation (see the Contact page).`,
    seo: { noindex: true },
  },
  {
    slug: 'terms',
    kind: 'policy',
    title: 'Terms of service (template pending legal review)',
    summary: 'Template terms; requires legal review before publication to customers.',
    sortOrder: 21,
    fields: { reviewStatus: 'template_pending_legal_review', effectiveDate: null },
    bodyMarkdown: `> **Template requiring legal review.** These terms are a draft structure prepared for the SimplexD platform. They have not been reviewed by a lawyer and must not be relied on until the business obtains professional review and sets an effective date.

## Services and quotations

Services are delivered under a scoped quotation that you accept in the portal. Published starting prices are indicative. Purchase representation fees are calculated only on an agreed percentage basis with a signed scope.

## Scenarios and reports

Calculators and comparisons are scenarios under stated assumptions, not valuations or investment advice. Reports are professional opinions with named reviewers and stated limitations.

## Accounts and organisations

You are responsible for the accuracy of the information you provide and for the people you invite to your organisation and the rights you grant them.

## Payments

Invoices follow accepted quotations. Payment is confirmed only after server-side verification with the payment provider. Refunds follow the published refund process.

## Cancellation

Requests can be cancelled with a reason; billing consequences depend on the stage reached and are stated in the quotation.`,
    seo: { noindex: true },
  },
  {
    slug: 'contact',
    kind: 'contact',
    title: 'Contact',
    summary: 'Contact details pending owner confirmation.',
    sortOrder: 30,
    fields: {
      email: null,
      phone: null,
      address: null,
      note: 'Contact details pending owner confirmation',
    },
    bodyMarkdown: `Contact details for SimplexD are pending confirmation by the business owner. Until they are confirmed, use the consultation form to reach the team; signed-in customers can add notes to any request.`,
  },
  {
    slug: 'goal-buy-safely',
    kind: 'goal_path',
    title: 'Buy safely',
    summary: 'Check title, documents and the site before you commit.',
    sortOrder: 40,
    fields: {
      key: 'buy_safely',
      description:
        'Due diligence with a document checklist, survey references, professional site findings and a decision memorandum before you commit to a purchase.',
      href: '/services/due-diligence',
    },
    bodyMarkdown:
      'Due diligence with a document checklist, survey references, professional site findings and a decision memorandum before you commit to a purchase. Purchase representation can then handle offers, conditions and the closing checklist.',
  },
  {
    slug: 'goal-build-with-oversight',
    kind: 'goal_path',
    title: 'Build with oversight',
    summary: 'Independent monitoring of your build with evidence-backed reports.',
    sortOrder: 41,
    fields: {
      key: 'build_with_oversight',
      description:
        'Construction monitoring with a project baseline, milestone plan, site visits, photo and video evidence, versioned progress reports and change orders that need your approval.',
      href: '/services/construction-monitoring',
    },
    bodyMarkdown:
      'Construction monitoring with a project baseline, milestone plan, site visits, photo and video evidence, versioned progress reports and change orders that need your approval. Architectural services cover the brief, design options and approvals tracking.',
  },
  {
    slug: 'goal-manage-property',
    kind: 'goal_path',
    title: 'Manage my property',
    summary: 'Leases, rent, maintenance and owner statements that reconcile.',
    sortOrder: 42,
    fields: {
      key: 'manage_property',
      description:
        'Property management with units and leases, rent schedules and collections, maintenance and recurring inspections, tenant tickets and owner statements.',
      href: '/services/property-management',
    },
    bodyMarkdown:
      'Property management with units and leases, rent schedules and collections, maintenance and recurring inspections, tenant tickets and owner statements that reconcile to the underlying records.',
  },
  {
    slug: 'goal-invest-and-compare',
    kind: 'goal_path',
    title: 'Invest and compare',
    summary: 'Compare markets with labelled evidence and your own assumptions.',
    sortOrder: 43,
    fields: {
      key: 'invest_and_compare',
      description:
        'Compare up to four markets in the explorer with evidence badges, adjust scoring priorities, run cost and rent scenarios and request local verification.',
      href: '/explore',
    },
    bodyMarkdown:
      'Compare up to four markets in the explorer with evidence badges, adjust scoring priorities, run cost and rent scenarios and request local verification. Financial ranking stays gated until enough validated local evidence exists.',
  },
  {
    slug: 'diaspora',
    kind: 'page',
    title: 'For Nigerians abroad',
    summary: 'Oversee property in Nigeria from any time zone.',
    sortOrder: 50,
    bodyMarkdown: `## Oversight from anywhere

The customer portal shows what changed, what needs your decision, what is due and what happens next. Appointments are shown in your time zone alongside Africa/Lagos, and reminders respect your quiet hours.

## Evidence you can check

Site visits produce photos and video with capture details, reviewed reports and defect lists. Change orders and milestones wait for your approval before budgets move.

## Share with family and advisers

Invite household members and advisers to your organisation with explicit view, comment or approval rights. Everyone sees the same records; internal staff notes stay internal.

## Requests in your own time

Start a request from a saved scenario, add notes at any hour, and receive a scoped quotation to accept when you are ready.`,
    seo: {
      title: 'SimplexD for Nigerians abroad',
      description:
        'Oversee property in Nigeria from any time zone with evidence-backed reports and shared access for family and advisers.',
    },
  },
  {
    slug: 'local-nigeria',
    kind: 'page',
    title: 'For busy professionals in Nigeria',
    summary: 'Independent oversight without the site visits.',
    sortOrder: 51,
    bodyMarkdown: `## Oversight without the commute

Assign the site visits, material checks and progress reporting to an independent team and review the evidence from the portal.

## Clear next actions

Each engagement lists the decisions waiting on you: quotations to accept, change orders to approve, milestones to sign off and invoices due.

## Property management that reconciles

Leases, rent schedules, collections and maintenance are tracked against your properties, with owner statements that reconcile to the underlying records.

## One organisation, many people

Add a spouse, partner or adviser with the rights they need, and switch between organisations if you manage property for more than one household or company.`,
    seo: {
      title: 'SimplexD for busy professionals in Nigeria',
      description: 'Independent property oversight and management without the site visits.',
    },
  },
];

/** Inserts starter pages that do not exist yet. Returns the number inserted. */
export async function seedContentPages(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    await applyActorContext(tx, systemContext('seed-content'));
    let inserted = 0;
    for (const page of contentSeeds) {
      const existing = await tx
        .select({ id: s.contentPages.id })
        .from(s.contentPages)
        .where(eq(s.contentPages.slug, page.slug));
      if (existing.length > 0) continue;
      const now = new Date();
      const [row] = await tx
        .insert(s.contentPages)
        .values({
          slug: page.slug,
          kind: page.kind,
          title: page.title,
          status: 'published',
          locale: 'en',
          currentRevision: 1,
          publishedRevision: 1,
          publishedAt: now,
          seo: page.seo ?? null,
          sortOrder: page.sortOrder ?? 0,
          createdBy: null,
          updatedBy: null,
        })
        .onConflictDoNothing({ target: s.contentPages.slug })
        .returning({ id: s.contentPages.id });
      if (!row) continue;
      await tx.insert(s.contentRevisions).values({
        pageId: row.id,
        revision: 1,
        title: page.title,
        bodyMarkdown: page.bodyMarkdown,
        // Rendered lazily by the web app's sanitiser; the seed does not embed HTML.
        bodyHtmlSanitized: null,
        fields: page.fields ?? null,
        summary: page.summary,
        reviewStatus: 'published',
        createdBy: null,
      });
      inserted += 1;
    }
    return inserted;
  });
}
