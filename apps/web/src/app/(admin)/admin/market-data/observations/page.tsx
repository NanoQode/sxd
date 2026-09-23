import type { Metadata } from 'next';
import Link from 'next/link';
import { observationListQuerySchema } from '@simplexd/contracts';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Button, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listMarketOptions } from '@/server/admin/market-data/markets';
import { listObservationMetrics, listObservations } from '@/server/admin/market-data/observations';
import { cleanSearchParams } from '../_lib/params';
import { ObservationsQueue } from './observations-queue';

export const metadata: Metadata = { title: 'Observation queue' };
export const dynamic = 'force-dynamic';

export default async function ObservationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireStaffPage('market_data.read_drafts');
  const raw = cleanSearchParams(await searchParams);
  const hasFilters = Object.keys(raw).some((k) => k !== 'page' && k !== 'pageSize');
  const parsed = observationListQuerySchema.safeParse(
    hasFilters ? raw : { ...raw, pendingOnly: 'true' },
  );
  const query = parsed.success
    ? parsed.data
    : observationListQuerySchema.parse({ pendingOnly: 'true' });
  const ctx = adminContext(identity);
  const [result, metrics, markets] = await Promise.all([
    listObservations(ctx, query),
    listObservationMetrics(ctx),
    listMarketOptions(ctx),
  ]);
  const canEdit = hasStaffPermission(identity.actor, 'market_data.edit');
  return (
    <div className="space-y-4">
      <PageHeader
        title="Observations"
        description="Immutable source observations with their current interpretation. Publishing and rank eligibility need a data approver who did not submit the interpretation."
        actions={
          canEdit ? (
            <Link href="/admin/market-data/observations/new">
              <Button>Record observation</Button>
            </Link>
          ) : undefined
        }
      />
      <ObservationsQueue
        result={result}
        query={query}
        metrics={metrics}
        markets={markets}
        actorId={identity.session!.user.id}
        canPublish={hasStaffPermission(identity.actor, 'market_data.publish')}
        canEdit={canEdit}
      />
    </div>
  );
}
