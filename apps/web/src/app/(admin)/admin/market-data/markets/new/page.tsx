import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listMarketOptions, listStates } from '@/server/admin/market-data/markets';
import { listSources } from '@/server/admin/market-data/sources';
import { MarketForm } from '../_components/market-form';

export const metadata: Metadata = { title: 'New market' };
export const dynamic = 'force-dynamic';

export default async function NewMarketPage() {
  const identity = await requireStaffPage('market_data.edit');
  const ctx = adminContext(identity);
  const [states, sources, markets] = await Promise.all([
    listStates(ctx),
    listSources(ctx),
    listMarketOptions(ctx),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="New market"
        description="Creates a draft. Publication, service availability and evidence are managed separately; nothing here reaches the public site until an approver publishes it."
      />
      <MarketForm
        initial={null}
        states={states}
        sources={sources.map((s) => ({ id: s.id, title: s.title }))}
        markets={markets}
      />
    </div>
  );
}
