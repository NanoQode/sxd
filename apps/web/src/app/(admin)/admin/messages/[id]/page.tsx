import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, PageHeader, cn, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, requireAnyStaff } from '@/lib/admin/server/context';
import { staffThread } from '@/lib/admin/server/messages';
import { ApiAction } from '@/components/admin/api-action';
import { LoadError } from '@/components/admin/load-error';
import { Section } from '@/components/admin/section';
import { ParticipantsPanel } from '../_components/participants-panel';
import { ReplyBox } from '../_components/reply-box';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

const ENTITY_HREF: Record<string, (id: string) => string> = {
  service_request: (id) => `/admin/service-requests/${id}`,
  project: (id) => `/admin/projects/${id}`,
  property: (id) => `/admin/properties/${id}`,
  lead: (id) => `/admin/leads/${id}`,
  report: (id) => `/admin/reports/${id}`,
};

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/messages');
  const allowed = await attempt(async () =>
    requireAnyStaff(identity, ['messages.read_all', 'support.tickets.read']),
  );
  if (!allowed.ok)
    return <LoadError code={allowed.code} message={allowed.message} what="Messages" />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const thread = await staffThread(identity, id);
  if (!thread) notFound();
  const c = thread.conversation;
  const me = identity.session!.user.id;
  const closed = Boolean(c.closedAt);
  const candidates = [
    ...thread.staff.map((s) => ({ userId: s.userId, name: s.name, group: 'Staff' })),
    ...thread.orgMembers.map((m) => ({
      userId: m.userId,
      name: `${m.name} (${humanize(m.role)})`,
      group: thread.organizationName ?? 'Organisation',
    })),
  ].filter((v, i, arr) => arr.findIndex((x) => x.userId === v.userId) === i);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/messages" className="underline">
            Messages
          </Link>
        }
        title={c.subject}
        description={`${humanize(c.kind)}${thread.organizationName ? ` · ${thread.organizationName}` : ''} · started ${formatDateTimeLabel(c.createdAt)}`}
        actions={
          <>
            {closed ? (
              <Badge>closed {formatDateTimeLabel(c.closedAt!)}</Badge>
            ) : (
              <Badge tone="success">open</Badge>
            )}
            {c.entityType && c.entityId && ENTITY_HREF[c.entityType] ? (
              <Link href={ENTITY_HREF[c.entityType]!(c.entityId)} className="text-sm underline">
                Open linked {humanize(c.entityType).toLowerCase()}
              </Link>
            ) : null}
            {!closed && thread.amParticipant ? (
              <ApiAction
                path={`/api/v1/conversations/${c.id}/close`}
                label="Close conversation"
                variant="ghost"
                confirm={{
                  title: 'Close this conversation?',
                  description: 'Participants keep read access; nobody can reply.',
                  confirmLabel: 'Close',
                }}
                successMessage="Conversation closed"
              />
            ) : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Section
          title={`Messages (${thread.messages.length})`}
          description="Oldest first. Amber messages are internal notes that customers and partners never see."
        >
          {thread.nextCursor ? (
            <p className="text-xs text-fg-muted">Showing the latest 100 messages.</p>
          ) : null}
          {thread.messages.length === 0 ? <p className="text-fg-muted">No messages yet.</p> : null}
          <ol className="space-y-2" aria-label="Messages">
            {thread.messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  'rounded-md border p-3',
                  m.internalOnly
                    ? 'border-warning/60 bg-warning-soft/40'
                    : m.senderUserId === me
                      ? 'border-primary/40 bg-primary-soft/30'
                      : 'border-border bg-bg',
                )}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  <span className="font-medium text-fg">{m.senderName ?? 'System'}</span>
                  <span>{formatDateTimeLabel(m.createdAt)}</span>
                  {m.internalOnly ? <Badge tone="warning">internal note</Badge> : null}
                  {m.editedAt ? <span>edited</span> : null}
                </div>
                <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                {m.attachmentFileIds.length > 0 ? (
                  <p className="mt-1 text-xs">
                    {m.attachmentFileIds.map((f) => (
                      <a key={f} href={`/api/v1/files/${f}/download`} className="mr-2 underline">
                        attachment {f.slice(0, 8)}
                      </a>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          <ReplyBox conversationId={c.id} amParticipant={thread.amParticipant} closed={closed} />
        </Section>
        <Section title="Participants">
          <ParticipantsPanel
            conversationId={c.id}
            participants={c.participants}
            candidates={candidates}
            me={me}
            amParticipant={thread.amParticipant}
            closed={closed}
          />
        </Section>
      </div>
    </div>
  );
}
