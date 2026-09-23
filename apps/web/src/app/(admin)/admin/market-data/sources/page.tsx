import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listSources } from '@/server/admin/market-data/sources';
import { SourcesManager } from './sources-manager';

export const metadata: Metadata = { title: 'Sources' };
export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  const identity = await requireStaffPage('market_data.read_drafts');
  const items = await listSources(adminContext(identity), { limit: 500 });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Sources"
        description="Every observation and coordinate cites a registered source with its license and permitted use. A source read is not a business or legal verification."
      />
      <SourcesManager items={items} canEdit={hasStaffPermission(identity.actor, 'market_data.edit')} />
    </div>
  );
}
