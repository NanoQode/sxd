import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError } from '@simplexd/contracts';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { getMarket, listMarketOptions, listStates } from '@/server/admin/market-data/markets';
import { listSources } from '@/server/admin/market-data/sources';
import { MarketForm } from '../../_components/market-form';

export const metadata: Metadata = { title: 'Edit market' };
export const dynamic = 'force-dynamic';

export default async function EditMarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireStaffPage('market_data.edit');
  const ctx = adminContext(identity);
  let market;
  try {
    market = await getMarket(ctx, id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') notFound();
    throw err;
  }
  const [states, sources, markets] = await Promise.all([listStates(ctx), listSources(ctx), listMarketOptions(ctx)]);
  return (
    <div className="space-y-6">
      <PageHeader title={`Edit ${market.name}`} eyebrow={`Version ${market.version}`} description="Changes are saved as a new revision with your reason and can be rolled back." />
      <MarketForm
        initial={{
          id: market.id,
          version: market.version,
          name: market.name,
          slug: market.slug,
          aliases: market.aliases,
          stateId: market.stateId,
          geopoliticalZone: market.geopoliticalZone,
          displayOrder: market.displayOrder,
          selectionBasis: market.selectionBasis,
          location: market.location,
          coordinateSourceId: market.coordinateSourceId,
          coordinateAccuracy: market.coordinateAccuracy,
          parentMarketId: market.parentMarketId,
          overlapNote: market.overlapNote,
          serviceAvailability: market.serviceAvailability,
          profileMarkdown: market.profileMarkdown,
          supplyMappingMethod: market.supplyMappingMethod,
          publicationState: market.publicationState,
        }}
        states={states}
        sources={sources.map((s) => ({ id: s.id, title: s.title }))}
        markets={markets}
      />
    </div>
  );
}
