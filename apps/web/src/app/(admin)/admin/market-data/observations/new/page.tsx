import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listMarketOptions, listStates } from '@/server/admin/market-data/markets';
import { listSources } from '@/server/admin/market-data/sources';
import { ObservationForm } from './observation-form';

export const metadata: Metadata = { title: 'Record observation' };
export const dynamic = 'force-dynamic';

export default async function NewObservationPage({
  searchParams,
}: {
  searchParams: Promise<{ marketId?: string }>;
}) {
  const identity = await requireStaffPage('market_data.edit');
  const { marketId } = await searchParams;
  const ctx = adminContext(identity);
  const [sources, markets, states] = await Promise.all([
    listSources(ctx, { limit: 500 }),
    listMarketOptions(ctx),
    listStates(ctx),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Record an observation"
        description="Observations are immutable: the source read, its dates and provenance never change. Interpretation, review and publication are versioned separately. Retrieval date is not the observation date."
      />
      <ObservationForm
        sources={sources.map((s) => ({ id: s.id, title: s.title, licenseRights: s.licenseRights }))}
        markets={markets}
        states={states}
        defaultMarketId={marketId ?? ''}
      />
    </div>
  );
}
