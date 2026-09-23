import type { Metadata } from 'next';
import Link from 'next/link';
import { conversationKindSchema } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, requireAnyStaff } from '@/lib/admin/server/context';
import { staffInbox } from '@/lib/admin/server/messages';
import { listStaffAssignees } from '@/server/leads/admin';
import {
  FilterBar,
  FilterCheckbox,
  FilterInput,
  FilterSelect,
} from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { Pagination } from '../_components/pagination';
import { NewInternalConversation } from './_components/new-internal-conversation';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/messages');
  const allowed = await attempt(async () =>
    requireAnyStaff(identity, ['messages.read_all', 'support.tickets.read']),
  );
  if (!allowed.ok)
    return <LoadError code={allowed.code} message={allowed.message} what="Messages" />;
  const raw = await searchParams;
  const page = Math.max(1, Number(raw.page) || 1);
  const status = raw.status === 'closed' || raw.status === 'all' ? raw.status : 'open';
  const kind = conversationKindSchema.safeParse(raw.kind).success ? raw.kind : undefined;
  const [inbox, staff] = await Promise.all([
    staffInbox(identity, {
      status,
      kind,
      mine: raw.mine === '1',
      q: raw.q?.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    listStaffAssignees(identity),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description={
          inbox.readAll
            ? 'Every conversation across customers, tenants and partners. You can read threads you are not in; join one to reply. Customer conversations start from the customer page.'
            : 'Conversations you take part in. Support tickets are opened from a customer page.'
        }
        actions={
          <NewInternalConversation
            staff={staff.map((s) => ({ userId: s.userId, name: s.name }))}
            me={identity.session!.user.id}
          />
        }
      />
      <SavedViewsBar tableKey="messages" />
      <FilterBar>
        <FilterSelect
          name="status"
          label="Status"
          value={raw.status}
          allLabel="Open"
          options={[
            { value: 'closed', label: 'Closed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <FilterSelect
          name="kind"
          label="Kind"
          value={kind}
          options={conversationKindSchema.options.map((k) => ({ value: k, label: humanize(k) }))}
        />
        <FilterInput name="q" label="Subject" value={raw.q} placeholder="Search subjects" />
        {inbox.readAll ? (
          <FilterCheckbox
            name="mine"
            label="Only conversations I am in"
            checked={raw.mine === '1'}
          />
        ) : null}
      </FilterBar>
      <DataTable
        caption="Conversations"
        rows={inbox.items}
        rowKey={(c) => c.id}
        rowLabel={(c) => c.subject}
        emptyMessage="No conversations in this view."
        columns={[
          {
            key: 'subject',
            header: 'Conversation',
            cell: (c) => (
              <span>
                <Link
                  href={`/admin/messages/${c.id}`}
                  className={
                    c.unreadCount > 0
                      ? 'font-semibold text-primary underline'
                      : 'text-primary underline'
                  }
                >
                  {c.subject}
                </Link>{' '}
                {c.unreadCount > 0 ? <Badge tone="primary">{c.unreadCount} unread</Badge> : null}
                {c.lastMessagePreview ? (
                  <span className="block max-w-prose truncate text-xs text-fg-muted">
                    {c.lastMessagePreview}
                  </span>
                ) : null}
              </span>
            ),
          },
          { key: 'kind', header: 'Kind', cell: (c) => humanize(c.kind) },
          {
            key: 'org',
            header: 'Organisation',
            cell: (c) =>
              c.organizationId ? (
                <Link href={`/admin/customers/${c.organizationId}`} className="underline">
                  {c.organizationName ?? 'organisation'}
                </Link>
              ) : (
                'internal'
              ),
            hideOnMobile: true,
          },
          {
            key: 'who',
            header: 'Participants',
            cell: (c) => (
              <span className="text-xs">
                {c.participantNames.join(', ')}
                {!c.amParticipant ? <Badge className="ml-1">reading only</Badge> : null}
              </span>
            ),
            hideOnMobile: true,
          },
          {
            key: 'last',
            header: 'Last message',
            cell: (c) => (c.lastMessageAt ? formatDateTimeLabel(c.lastMessageAt) : '—'),
          },
          { key: 'n', header: 'Messages', cell: (c) => c.messageCount, hideOnMobile: true },
          {
            key: 'st',
            header: 'State',
            cell: (c) => (c.closedAt ? <Badge>closed</Badge> : <Badge tone="success">open</Badge>),
          },
        ]}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={inbox.total} />
    </div>
  );
}
