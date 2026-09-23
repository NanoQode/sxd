import 'server-only';
import { cache } from 'react';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { PublishedContent } from '@simplexd/contracts';
import { anonymousContext, getDb, schema, withActor } from '@simplexd/db';
import { cached } from '@/lib/cache';
import { renderMarkdown } from '@/lib/markdown';
import { getPublishedContent } from '@/server/content/public';
import {
  priceAnchorLabel,
  type PackagePublication,
  type PriceBasis,
} from '@/components/public/price-anchor';

/**
 * Public service catalogue: the eight core services with their editable price
 * anchors, plus the expansion portfolio as "planned" services. Reads the
 * services and service_packages tables (public read policy) and applies an
 * optional CMS override (content kind `service`, slug = service slug) for
 * long-form copy and SEO metadata.
 */

export interface ServicePackageView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  scopeHtml: string | null;
  priceBasis: PriceBasis;
  amountKobo: string | null;
  percentageBps: number | null;
  currency: string;
  minimumScope: string | null;
  exclusions: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  publicationState: PackagePublication;
  /** Presentation label; null when the package must not be shown. */
  priceLabel: string | null;
}

export type ServiceAvailabilityMode = 'request' | 'inquiry_only';

export interface ServiceCatalogItem {
  id: string;
  slug: string;
  name: string;
  category: 'core' | 'expansion';
  shortDescription: string;
  descriptionHtml: string | null;
  deliverables: string[];
  completionEvidence: string | null;
  workflowTemplateKey: string;
  featureFlagKey: string | null;
  featureFlagEnabled: boolean;
  bookingEnabled: boolean;
  inquiryEnabled: boolean;
  staffed: boolean;
  regulatedGated: boolean;
  commercialModel: string | null;
  iconKey: string | null;
  publicationState: string;
  sortOrder: number;
  /** request: consultation request available; inquiry_only: interest registration only. */
  availability: ServiceAvailabilityMode;
  packages: ServicePackageView[];
  /** The package shown as the headline anchor, if any. */
  primaryPackage: ServicePackageView | null;
  cms: PublishedContent | null;
}

export interface ServiceCatalog {
  core: ServiceCatalogItem[];
  planned: ServiceCatalogItem[];
  generatedAt: string;
}

interface RawCatalog {
  services: Array<typeof schema.services.$inferSelect>;
  packages: Array<
    Omit<typeof schema.servicePackages.$inferSelect, 'amountKobo'> & { amountKobo: string | null }
  >;
  flags: Record<string, boolean>;
}

async function loadRaw(): Promise<RawCatalog> {
  return withActor(getDb(), anonymousContext, async (tx) => {
    const services = await tx
      .select()
      .from(schema.services)
      .where(ne(schema.services.publicationState, 'archived'))
      .orderBy(asc(schema.services.sortOrder), asc(schema.services.name));
    const ids = services.map((s) => s.id);
    const packages =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(schema.servicePackages)
            .where(
              and(
                inArray(schema.servicePackages.serviceId, ids),
                inArray(schema.servicePackages.publicationState, ['in_review', 'published']),
              ),
            )
            .orderBy(asc(schema.servicePackages.name));
    const flagKeys = services.map((s) => s.featureFlagKey).filter((k): k is string => Boolean(k));
    const flagRows =
      flagKeys.length === 0
        ? []
        : await tx
            .select({ key: schema.featureFlags.key, enabled: schema.featureFlags.enabled })
            .from(schema.featureFlags)
            .where(inArray(schema.featureFlags.key, flagKeys));
    return {
      services,
      packages: packages.map((p) => ({
        ...p,
        amountKobo: p.amountKobo === null ? null : p.amountKobo.toString(),
      })),
      flags: Object.fromEntries(flagRows.map((f) => [f.key, f.enabled])),
    };
  });
}

function toPackageView(
  p: RawCatalog['packages'][number],
  isPublishedService: boolean,
): ServicePackageView {
  const publicationState = p.publicationState as PackagePublication;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    scopeHtml: p.scopeMarkdown ? renderMarkdown(p.scopeMarkdown) : null,
    priceBasis: p.priceBasis as PriceBasis,
    amountKobo: p.amountKobo,
    percentageBps: p.percentageBps,
    currency: p.currency,
    minimumScope: p.minimumScope,
    exclusions: p.exclusions,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    publicationState,
    priceLabel: isPublishedService
      ? priceAnchorLabel({
          priceBasis: p.priceBasis as PriceBasis,
          amountKobo: p.amountKobo,
          percentageBps: p.percentageBps,
          publicationState,
        })
      : null,
  };
}

function availabilityFor(
  s: typeof schema.services.$inferSelect,
  flagEnabled: boolean,
): ServiceAvailabilityMode {
  if (s.category === 'core')
    return s.publicationState === 'published' && s.bookingEnabled ? 'request' : 'inquiry_only';
  return flagEnabled && s.staffed && s.bookingEnabled ? 'request' : 'inquiry_only';
}

async function buildCatalog(): Promise<ServiceCatalog> {
  const raw = await loadRaw();
  const items: ServiceCatalogItem[] = [];
  for (const s of raw.services) {
    if (s.category === 'core' && s.publicationState !== 'published') continue;
    const flagEnabled = s.featureFlagKey ? Boolean(raw.flags[s.featureFlagKey]) : true;
    const isPublished = s.publicationState === 'published';
    const packages = raw.packages
      .filter((p) => p.serviceId === s.id)
      .map((p) => toPackageView(p, isPublished));
    const primaryPackage =
      packages.find((p) => p.publicationState === 'published') ?? packages[0] ?? null;
    let cms: PublishedContent | null = null;
    try {
      const page = await getPublishedContent(s.slug);
      cms = page && page.kind === 'service' ? page : null;
    } catch {
      cms = null;
    }
    items.push({
      id: s.id,
      slug: s.slug,
      name: s.name,
      category: s.category,
      shortDescription:
        cms?.fields.intro && typeof cms.fields.intro === 'string'
          ? cms.fields.intro
          : s.shortDescription,
      descriptionHtml:
        cms?.bodyHtml || (s.descriptionMarkdown ? renderMarkdown(s.descriptionMarkdown) : null),
      deliverables: Array.isArray(s.deliverables) ? s.deliverables : [],
      completionEvidence: s.completionEvidence,
      workflowTemplateKey: s.workflowTemplateKey,
      featureFlagKey: s.featureFlagKey,
      featureFlagEnabled: flagEnabled,
      bookingEnabled: s.bookingEnabled,
      inquiryEnabled: s.inquiryEnabled,
      staffed: s.staffed,
      regulatedGated: s.regulatedGated,
      commercialModel: s.commercialModel,
      iconKey: s.iconKey,
      publicationState: s.publicationState,
      sortOrder: s.sortOrder,
      availability: availabilityFor(s, flagEnabled),
      packages,
      primaryPackage,
      cms,
    });
  }
  return {
    core: items.filter((i) => i.category === 'core'),
    planned: items.filter((i) => i.category === 'expansion'),
    generatedAt: new Date().toISOString(),
  };
}

/** Cached for 60 seconds; per-request deduplicated. */
export const listServiceCatalog = cache(async (): Promise<ServiceCatalog> => {
  return cached('services:catalog:v1', 60, buildCatalog);
});

export async function getServiceBySlug(slug: string): Promise<ServiceCatalogItem | null> {
  const catalog = await listServiceCatalog();
  return [...catalog.core, ...catalog.planned].find((s) => s.slug === slug) ?? null;
}

export interface CoverageSummary {
  available: number;
  limited: number;
  onRequest: number;
  pending: number;
  unavailable: number;
  publishedMarkets: number;
}

/** Counts of published markets by service availability for one service (map coverage stays separate). */
export const getServiceCoverageSummary = cache(
  async (serviceId: string): Promise<CoverageSummary> => {
    return cached(`services:coverage:${serviceId}`, 60, async () => {
      const rows = await withActor(getDb(), anonymousContext, async (tx) => {
        const coverage = await tx
          .select({ availability: schema.serviceCoverage.availability })
          .from(schema.serviceCoverage)
          .innerJoin(schema.markets, eq(schema.markets.id, schema.serviceCoverage.marketId))
          .where(
            and(
              eq(schema.serviceCoverage.serviceId, serviceId),
              eq(schema.markets.publicationState, 'published'),
            ),
          );
        const published = await tx
          .select({ id: schema.markets.id })
          .from(schema.markets)
          .where(eq(schema.markets.publicationState, 'published'));
        return { coverage, publishedMarkets: published.length };
      });
      const summary: CoverageSummary = {
        available: 0,
        limited: 0,
        onRequest: 0,
        pending: 0,
        unavailable: 0,
        publishedMarkets: rows.publishedMarkets,
      };
      for (const c of rows.coverage) {
        switch (c.availability) {
          case 'available':
            summary.available += 1;
            break;
          case 'limited':
            summary.limited += 1;
            break;
          case 'on_request':
            summary.onRequest += 1;
            break;
          case 'pending_operations_confirmation':
            summary.pending += 1;
            break;
          case 'unavailable':
            summary.unavailable += 1;
            break;
        }
      }
      return summary;
    });
  },
);

/** Shape exposed by GET /api/v1/services (no internal ids beyond the slug). */
export interface PublicServiceDto {
  slug: string;
  name: string;
  category: 'core' | 'expansion';
  shortDescription: string;
  deliverables: string[];
  completionEvidence: string | null;
  availability: ServiceAvailabilityMode;
  bookable: boolean;
  priceLabel: string | null;
  priceBasis: PriceBasis | null;
  packagePublicationState: PackagePublication | null;
  href: string;
}

export function toPublicServiceDto(s: ServiceCatalogItem): PublicServiceDto {
  return {
    slug: s.slug,
    name: s.name,
    category: s.category,
    shortDescription: s.shortDescription,
    deliverables: s.deliverables,
    completionEvidence: s.completionEvidence,
    availability: s.availability,
    bookable: s.availability === 'request',
    priceLabel: s.primaryPackage?.priceLabel ?? null,
    priceBasis: s.primaryPackage?.priceBasis ?? null,
    packagePublicationState: s.primaryPackage?.publicationState ?? null,
    href: `/services/${s.slug}`,
  };
}
