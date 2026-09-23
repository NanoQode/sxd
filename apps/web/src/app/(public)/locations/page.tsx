import type { Metadata } from 'next';
import Link from 'next/link';
import type { MarketSummaryDto } from '@simplexd/contracts';
import { buttonVariants, EmptyState, PageHeader } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { MarketCard, ZONE_NAMES } from '@/components/public/market-card';
import { Section } from '@/components/public/section';
import { loadMarkets, publicMetadata, siteUrl } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Locations',
  description:
    'Published Nigerian property markets grouped by geopolitical zone, each with its evidence counts, service availability status and what evidence is still missing.',
  path: '/locations',
});

const ZONE_ORDER: MarketSummaryDto['geopoliticalZone'][] = ['SW', 'SS', 'SE', 'NC', 'NW', 'NE'];

export default async function LocationsPage() {
  const result = await loadMarkets();
  const items = result.status === 'ok' ? result.data.items : [];
  const byZone = ZONE_ORDER.map((zone) => ({
    zone,
    markets: items
      .filter((m) => m.geopoliticalZone === zone)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)),
  })).filter((g) => g.markets.length > 0);

  return (
    <>
      <Breadcrumbs items={[{ name: 'Locations', href: '/locations' }]} baseUrl={siteUrl()} />
      <div className="sx-container py-6">
        <PageHeader
          eyebrow="Locations"
          title="Published markets by geopolitical zone"
          description="Markets are published one by one after review. Each card counts city-level observations separately from statewide context and shows whether SimplexD services are actually available there, independent of map coverage."
          actions={
            <Link href="/explore" className={buttonVariants({ variant: 'secondary' })}>
              Open the map explorer
            </Link>
          }
        />
        {result.status === 'ok' ? (
          <p className="mt-3 text-sm text-fg-muted">
            {result.data.total} published market{result.data.total === 1 ? '' : 's'}.
            {result.data.policy.defaultFinancialRankingEnabled
              ? ' Financial ranking is active for eligible markets.'
              : ' Financial ranking is switched off until locally applicable cost and rental evidence meets the coverage policy.'}
          </p>
        ) : null}
      </div>

      {result.status === 'unavailable' ? (
        <div className="sx-container pb-10">
          <EmptyState
            tone="warning"
            title="Location data is not available yet"
            description="The market read model did not respond. Published markets, their evidence and service availability will appear here once it is online."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/explore" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  Try the explorer
                </Link>
                <Link href="/book" className={buttonVariants({ size: 'sm' })}>
                  Ask about a location
                </Link>
              </div>
            }
          />
        </div>
      ) : byZone.length === 0 ? (
        <div className="sx-container pb-10">
          <EmptyState
            title="No markets have been published yet"
            description="Imported markets stay in draft until a data approver reviews and publishes them. Ask the team about a location in the meantime."
            action={
              <Link href="/book" className={buttonVariants({ size: 'sm' })}>
                Ask about a location
              </Link>
            }
          />
        </div>
      ) : (
        byZone.map((group, i) => (
          <Section
            key={group.zone}
            id={`zone-${group.zone.toLowerCase()}`}
            title={`${ZONE_NAMES[group.zone]} (${group.zone})`}
            description={`${group.markets.length} published market${group.markets.length === 1 ? '' : 's'}`}
            tone={i % 2 === 1 ? 'sunken' : 'default'}
            className="py-8"
          >
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.markets.map((m) => (
                <li key={m.id}>
                  <MarketCard market={m} />
                </li>
              ))}
            </ul>
          </Section>
        ))
      )}
      <CtaBand
        title="Compare locations on evidence"
        description="Pick up to four markets, adjust priorities and save a dated comparison. Unknown values stay unknown."
        primary={{ label: 'Open the explorer', href: '/explore' }}
        secondary={{ label: 'Book a consultation', href: '/book' }}
      />
    </>
  );
}
