import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, DataTable, EmptyState, PageHeader, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listScenarios } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Scenarios' };
export const dynamic = 'force-dynamic';

export default async function ScenariosPage() {
  const identity = await requireSignedIn('/portal/scenarios');
  const scenarios = await listScenarios(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Saved scenarios"
        description="Location comparisons and calculator assumptions you saved in the explorer. A scenario can become a service request without re-entering anything."
        actions={
          <Link href="/explore" className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm font-medium">
            Open the explorer
          </Link>
        }
      />
      {scenarios.length === 0 ? (
        <EmptyState
          title="No saved scenarios"
          description="Compare up to four markets in the explorer and save the scenario to keep it here. Scenarios saved before you signed in are attached to your account when you save them again."
          action={
            <Link href="/explore" className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary">
              Explore where to build
            </Link>
          }
        />
      ) : (
        <DataTable
          caption="Saved scenarios"
          rows={scenarios}
          rowKey={(s) => s.id}
          rowLabel={(s) => s.name}
          columns={[
            {
              key: 'name',
              header: 'Scenario',
              cell: (s) => (
                <Link href={`/explore?scenario=${s.id}`} className="font-medium text-primary underline">
                  {s.name}
                </Link>
              ),
            },
            { key: 'objective', header: 'Objective', cell: (s) => humanize(s.objective) },
            {
              key: 'mode',
              header: 'Mode',
              cell: (s) => <Badge tone={s.mode === 'evidence' ? 'info' : 'gold'}>{s.mode === 'evidence' ? 'Evidence' : 'Assumptions'}</Badge>,
            },
            { key: 'markets', header: 'Markets', cell: (s) => String(s.marketCount), hideOnMobile: true },
            { key: 'updated', header: 'Updated', cell: (s) => formatDateLabel(s.updatedAt, zone) },
            {
              key: 'action',
              header: 'Service',
              cell: (s) =>
                s.convertedServiceRequestId ? (
                  <Link href={`/portal/requests/${s.convertedServiceRequestId}`} className="text-primary underline">
                    View request
                  </Link>
                ) : (
                  <Link href={`/portal/requests/new?scenario=${s.id}`} className="text-primary underline">
                    Start a service from this scenario
                  </Link>
                ),
            },
          ]}
        />
      )}
    </div>
  );
}
