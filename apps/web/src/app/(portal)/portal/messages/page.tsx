import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listConversations } from '@/server/conversations/service';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const identity = await requireSignedIn('/portal/messages');
  const { status: statusParam, cursor } = await searchParams;
  const status = statusParam === 'closed' || statusParam === 'all' ? statusParam : 'open';
  const page = await listConversations(identity, { status, limit: 50, cursor });
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Conversations with your assigned team. Internal staff-only messages are never included in your view."
      />
      <nav aria-label="Filter conversations" className="flex flex-wrap gap-2">
        {(['open', 'closed', 'all'] as const).map((s) => (
          <Link
            key={s}
            href={`/portal/messages?status=${s}`}
            aria-current={status === s ? 'page' : undefined}
            className={`sx-touch inline-flex items-center rounded-full border px-3 text-sm ${status === s ? 'border-primary bg-primary-soft text-primary' : 'border-border text-fg-muted'}`}
          >
            {humanize(s)}
          </Link>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <EmptyState
          title={status === 'open' ? 'No open conversations' : 'No conversations'}
          description="Start a conversation from a request's overview once a project manager is assigned, or wait for the team to message you. Until then, notes on a request are the fastest way to reach us."
          action={
            <Link
              href="/portal/requests"
              className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm font-medium"
            >
              Go to requests
            </Link>
          }
        />
      ) : (
        <DataTable
          caption="Conversations"
          rows={page.items}
          rowKey={(c) => c.id}
          rowLabel={(c) => c.subject}
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              cell: (c) => (
                <span className="flex items-center gap-2">
                  <Link
                    href={`/portal/messages/${c.id}`}
                    className="font-medium text-primary underline"
                  >
                    {c.subject}
                  </Link>
                  {c.unreadCount > 0 ? <Badge tone="primary">{c.unreadCount} unread</Badge> : null}
                </span>
              ),
            },
            { key: 'kind', header: 'Kind', cell: (c) => humanize(c.kind) },
            {
              key: 'last',
              header: 'Last message',
              cell: (c) => (c.lastMessageAt ? formatDateTimeLabel(c.lastMessageAt, zone) : '—'),
            },
            { key: 'state', header: 'State', cell: (c) => (c.closedAt ? 'Closed' : 'Open') },
          ]}
        />
      )}
      {page.nextCursor ? (
        <Link
          href={`/portal/messages?${new URLSearchParams({ status, cursor: page.nextCursor }).toString()}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load older conversations
        </Link>
      ) : null}
    </div>
  );
}
