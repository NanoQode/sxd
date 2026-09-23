import type { Metadata } from 'next';
import { Badge, DataTable, EmptyState, PageHeader, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listConversations } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const identity = await requireSignedIn('/portal/messages');
  const conversations = await listConversations(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Conversations with your assigned team. Internal staff-only messages are never included in your view."
      />
      {conversations.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="A conversation with your team opens when a request is triaged and a contact is assigned. Until then, notes on a request are the fastest way to reach us."
        />
      ) : (
        <DataTable
          caption="Conversations"
          rows={conversations}
          rowKey={(c) => c.id}
          rowLabel={(c) => c.subject}
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              cell: (c) => (
                <span className="flex items-center gap-2 font-medium">
                  {c.subject}
                  {c.unread ? <Badge tone="primary">Unread</Badge> : null}
                </span>
              ),
            },
            { key: 'kind', header: 'Kind', cell: (c) => humanize(c.kind) },
            { key: 'last', header: 'Last message', cell: (c) => (c.lastMessageAt ? formatDateTimeLabel(c.lastMessageAt, zone) : '—') },
            { key: 'state', header: 'State', cell: (c) => (c.closedAt ? 'Closed' : 'Open') },
          ]}
        />
      )}
    </div>
  );
}
