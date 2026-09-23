import type { Metadata } from 'next';
import Link from 'next/link';
import { adminMarketListQuerySchema } from '@simplexd/contracts';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Button, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listMarkets, listStates } from '@/server/admin/market-data/markets';
import { MarketsTable } from './_components/markets-table';
import { cleanSearchParams } from './_lib/params';

export const metadata: Metadata = { title: 'Markets' };
export const dynamic = 'force-dynamic';

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireStaffPage('market_data.read_drafts');
  const parsed = adminMarketListQuerySchema.safeParse(cleanSearchParams(await searchParams));
  const query = parsed.success ? parsed.data : adminMarketListQuerySchema.parse({});
  const ctx = adminContext(identity);
  const [result, states] = await Promise.all([listMarkets(ctx, query), listStates(ctx)]);
  const canPublish = hasStaffPermission(identity.actor, 'market_data.publish');
  const canEdit = hasStaffPermission(identity.actor, 'market_data.edit');
  return (
    <div className="space-y-4">
      <PageHeader
        title="Markets"
        description="All 50 seeded locations plus any added since, including drafts. Filters live in the URL, so a filtered view can be saved and shared."
        actions={
          canEdit ? (
            <Link href="/admin/market-data/markets/new">
              <Button>New market</Button>
            </Link>
          ) : undefined
        }
      />
      <MarketsTable
        result={result}
        query={query}
        states={states}
        canPublish={canPublish}
        invalidQuery={!parsed.success}
      />
    </div>
  );
}
