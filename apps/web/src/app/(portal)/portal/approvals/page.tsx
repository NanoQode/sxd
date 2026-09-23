import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { loadQuotesForRequest } from '@/lib/portal/server/finance';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { listPendingApprovals } from '@/server/projects/approvals';
import { listServiceRequests } from '@/server/requests/queries';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

/**
 * Everything waiting for a customer decision: project approvals (change
 * orders, budgets, milestones) from the approvals endpoint plus issued
 * quotes on open requests. Deciding happens on the record itself.
 */
export default async function ApprovalsPage() {
  const identity = await requireSignedIn('/portal/approvals');
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity);
  const [pending, quoted] = await Promise.all([
    listPendingApprovals(identity),
    identity.ctx.organizationId
      ? listServiceRequests(identity, { status: 'quoted', limit: 50 })
      : Promise.resolve({ items: [], nextCursor: null }),
  ]);
  const quotes = (
    await Promise.all(
      quoted.items.map(async (r) => {
        const list = await loadQuotesForRequest(identity, r.id).catch(() => []);
        return list.filter((q) => q.status === 'issued').map((q) => ({ request: r, quote: q }));
      }),
    )
  ).flat();

  const hrefFor = (entityType: string, projectId: string | null) => {
    if (!projectId) return '/portal/projects';
    return entityType === 'budget_version'
      ? `/portal/projects/${projectId}?tab=decisions`
      : `/portal/projects/${projectId}?tab=decisions`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals pending"
        description="Quotes, change orders, budget versions and milestones waiting on your organisation. Each decision is recorded with your name and note."
      />
      {!caps.acceptQuotes && !caps.approveChangeOrders ? (
        <Alert tone="info" title="You can view but not decide">
          {capabilityNote(caps, 'Deciding approvals')}
        </Alert>
      ) : null}
      <section aria-labelledby="quotes-heading" className="space-y-3">
        <h2 id="quotes-heading" className="font-medium">
          Quotes to accept or reject
        </h2>
        {quotes.length === 0 ? (
          <p className="text-sm text-fg-muted">No issued quote is waiting for you.</p>
        ) : (
          <DataTable
            caption="Issued quotes"
            rows={quotes}
            rowKey={(q) => q.quote.id}
            rowLabel={(q) => `${q.request.reference} quote`}
            columns={[
              {
                key: 'request',
                header: 'Request',
                cell: (q) => (
                  <Link
                    href={`/portal/quotes/${q.quote.id}`}
                    className="font-medium text-primary underline"
                  >
                    {q.request.reference} · {q.request.title}
                  </Link>
                ),
              },
              { key: 'version', header: 'Version', cell: (q) => `v${q.quote.currentVersion}` },
              {
                key: 'updated',
                header: 'Issued',
                cell: (q) => formatDateTimeLabel(q.quote.updatedAt, zone),
              },
            ]}
          />
        )}
      </section>
      <section aria-labelledby="project-heading" className="space-y-3">
        <h2 id="project-heading" className="font-medium">
          Project decisions
        </h2>
        {pending.items.length === 0 ? (
          <EmptyState
            title="Nothing needs your decision"
            description="Approvals appear when a change order, budget version or milestone is waiting on you."
          />
        ) : (
          <DataTable
            caption="Pending project approvals"
            rows={pending.items}
            rowKey={(a) => a.id}
            rowLabel={(a) => a.entityTitle ?? humanize(a.entityType)}
            columns={[
              {
                key: 'what',
                header: 'Decision',
                cell: (a) => (
                  <Link
                    href={hrefFor(a.entityType, a.projectId)}
                    className="font-medium text-primary underline"
                  >
                    {a.entityTitle ?? humanize(a.entityType)}
                  </Link>
                ),
              },
              {
                key: 'type',
                header: 'Type',
                cell: (a) => <Badge tone="neutral">{humanize(a.entityType)}</Badge>,
              },
              { key: 'project', header: 'Project', cell: (a) => a.projectName ?? '—' },
              {
                key: 'requested',
                header: 'Requested',
                cell: (a) => formatDateTimeLabel(a.requestedAt, zone),
              },
              {
                key: 'expires',
                header: 'Expires',
                cell: (a) => (a.expiresAt ? formatDateTimeLabel(a.expiresAt, zone) : '—'),
                hideOnMobile: true,
              },
            ]}
          />
        )}
        {pending.actingAs.length === 0 && pending.items.length > 0 ? (
          <p className="text-xs text-fg-muted">Your role can see these but not decide them.</p>
        ) : null}
      </section>
    </div>
  );
}
