import type { Metadata } from 'next';
import type { PublishedContent } from '@simplexd/contracts';
import { humanize } from '@simplexd/ui';
import { locationIsIncomplete } from '@/components/public/site-content';
import { excerpt, publicMetadata, type MarketResult } from '../../_lib/site-data';

/**
 * Metadata for /locations/{slug}. Missing markets and unavailable data are
 * noindex; a market without observations, editorial profile or a published
 * CMS intro is "incomplete" and noindex as well, so search engines never
 * index an empty evidence page. A published intro supplies title and
 * description overrides through its SEO fields.
 */
export function locationMetadata(input: {
  slug: string;
  result: MarketResult;
  intro: PublishedContent | null;
}): Metadata {
  const { slug, result, intro } = input;
  if (result.status === 'missing')
    return { title: 'Location not found', robots: { index: false, follow: false } };
  if (result.status === 'unavailable') {
    return publicMetadata({
      title: 'Location data not available yet',
      description: 'Location data is not available yet.',
      path: `/locations/${slug}`,
      noindex: true,
    });
  }
  const m = result.market;
  const incomplete = locationIsIncomplete({
    localObservations: m.evidence.localObservations,
    regionalContextObservations: m.evidence.regionalContextObservations,
    profileMarkdown: m.profileMarkdown,
    hasIntro: Boolean(intro),
  });
  return publicMetadata({
    title: intro?.seo?.title ?? `${m.name}, ${m.stateName}${m.isFederalCapital ? '' : ' State'}`,
    description:
      intro?.seo?.description ??
      (intro ? excerpt(intro) : null) ??
      `${m.name} property market evidence: ${m.evidence.localObservations} local observation${m.evidence.localObservations === 1 ? '' : 's'}, ${m.evidence.regionalContextObservations} statewide context figures, service availability ${humanize(m.serviceAvailability).toLowerCase()}, and what is still missing.`,
    path: `/locations/${m.slug}`,
    noindex: incomplete || Boolean(intro?.seo?.noindex),
  });
}
