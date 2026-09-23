import 'server-only';
import { asc, eq } from 'drizzle-orm';
import type { BookableServiceDto } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { WORKFLOW_TEMPLATES, type WorkflowTemplateKey } from '@simplexd/domain/services';
import type { RequestIdentity } from '@/lib/auth/session';

type ServiceRow = typeof schema.services.$inferSelect;

/** A service is bookable when published, enabled for booking and (if flagged) its flag is on. */
export function isBookable(service: ServiceRow, flags: Record<string, boolean>): boolean {
  if (service.publicationState !== 'published') return false;
  if (!service.bookingEnabled) return false;
  if (service.featureFlagKey && !flags[service.featureFlagKey]) return false;
  return true;
}

export function intakeKeysFor(templateKey: string): string[] {
  const template = WORKFLOW_TEMPLATES[templateKey as WorkflowTemplateKey];
  return template ? [...template.intake] : [];
}

/**
 * Services shown in the intake flow: published services (bookable) plus
 * expansion services that accept inquiries, which register interest as a lead
 * instead of creating a request.
 */
export async function listIntakeServices(identity: RequestIdentity): Promise<BookableServiceDto[]> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ service: schema.services, pkg: schema.servicePackages })
      .from(schema.services)
      .leftJoin(schema.servicePackages, eq(schema.servicePackages.serviceId, schema.services.id))
      .orderBy(asc(schema.services.sortOrder), asc(schema.services.name)),
  );
  const byId = new Map<
    string,
    { service: ServiceRow; pkg: typeof schema.servicePackages.$inferSelect | null }
  >();
  for (const r of rows) {
    const existing = byId.get(r.service.id);
    if (!existing) byId.set(r.service.id, { service: r.service, pkg: r.pkg });
    else if (!existing.pkg && r.pkg) existing.pkg = r.pkg;
  }
  const out: BookableServiceDto[] = [];
  for (const { service, pkg } of byId.values()) {
    const bookable = isBookable(service, identity.featureFlags);
    const visible =
      service.publicationState === 'published' ||
      (service.category === 'expansion' && service.inquiryEnabled);
    if (!visible) continue;
    const publishedPackage = pkg && pkg.publicationState === 'published' ? pkg : null;
    out.push({
      id: service.id,
      slug: service.slug,
      name: service.name,
      category: service.category,
      shortDescription: service.shortDescription,
      deliverables: service.deliverables ?? [],
      workflowTemplateKey: service.workflowTemplateKey,
      intakeKeys: intakeKeysFor(service.workflowTemplateKey),
      bookable,
      inquiryEnabled: service.inquiryEnabled,
      startingPrice: publishedPackage
        ? {
            basis: publishedPackage.priceBasis,
            amountKobo:
              publishedPackage.amountKobo === null ? null : publishedPackage.amountKobo.toString(),
            percentageBps: publishedPackage.percentageBps,
          }
        : null,
    });
  }
  return out;
}

/** Human labels for intake keys defined by the workflow templates. */
export const INTAKE_FIELD_LABELS: Record<
  string,
  { label: string; hint?: string; multiline?: boolean }
> = {
  property: {
    label: 'Property or site',
    hint: 'Address or description of the property this request concerns.',
  },
  project_stage: {
    label: 'Project stage',
    hint: 'e.g. land only, foundations, roofing, finishing.',
  },
  drawings_or_boq: {
    label: 'Drawings or bill of quantities',
    hint: 'Describe what you already have. Uploads arrive in Wave 2.',
    multiline: true,
  },
  site_access: { label: 'Site access', hint: 'Who grants access and any constraints.' },
  title_documents: {
    label: 'Title documents held',
    hint: 'e.g. Certificate of Occupancy, deed of assignment, survey plan.',
    multiline: true,
  },
  seller_contact: { label: 'Seller or agent contact', hint: 'Name and how to reach them.' },
  brief: { label: 'Design brief', hint: 'What you want to build and for whom.', multiline: true },
  site_information: {
    label: 'Site information',
    hint: 'Location, size, topography, existing structures.',
    multiline: true,
  },
  budget_range: { label: 'Budget range', hint: 'Whole naira, low to high.' },
  units: { label: 'Units', hint: 'Number and type of units to manage.' },
  existing_leases: {
    label: 'Existing leases',
    hint: 'Current tenants and lease end dates, if any.',
    multiline: true,
  },
  access_contact: { label: 'Access contact', hint: 'Who meets the inspector on site.' },
  checklist_focus: {
    label: 'Inspection focus',
    hint: 'What should the inspector prioritise?',
    multiline: true,
  },
  search_criteria: {
    label: 'Search criteria',
    hint: 'Location, type, size and must-haves.',
    multiline: true,
  },
  budget: { label: 'Budget', hint: 'Whole naira.' },
  fee_basis_agreement: {
    label: 'Fee basis acknowledgement',
    hint: 'Purchase representation is charged on an agreed percentage basis with signed scope; confirm you understand.',
  },
  requirements: {
    label: 'Requirements',
    hint: 'Describe what you are looking for.',
    multiline: true,
  },
  locations: { label: 'Preferred locations', hint: 'Cities or neighbourhoods.' },
  owner_authority: {
    label: 'Owner authority',
    hint: 'Your relationship to the land and any authority documents.',
  },
  parcel: { label: 'Parcel details', hint: 'Size, survey reference and location.' },
  title_disclosures: {
    label: 'Title disclosures',
    hint: 'Known encumbrances, disputes or pending consents.',
    multiline: true,
  },
};

export function intakeLabel(key: string): { label: string; hint?: string; multiline?: boolean } {
  return (
    INTAKE_FIELD_LABELS[key] ?? {
      label: key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    }
  );
}
