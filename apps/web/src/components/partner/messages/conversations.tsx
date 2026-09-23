'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ConversationDetail, ConversationDto, MessageDto, Page } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  DataTable,
  EmptyState,
  Field,
  PageHeader,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { openSignedDownload } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, NotAvailable, RequestFailed } from '../common';

export function ConversationsList() {
  const p = usePartner();
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const list = useQuery({
    queryKey: ['partner', 'conversations', status],
    queryFn: () =>
      partnerFetch<Page<ConversationDto>>(
        withQuery('/api/v1/conversations', { status, limit: 100 }),
      ),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Conversations you take part in. Staff-only internal notes are never included in your view."
        actions={
          <div
            role="radiogroup"
            aria-label="Conversation status"
            className="inline-flex rounded-md border border-border p-0.5"
          >
            {(['open', 'closed', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                onClick={() => setStatus(s)}
                className={`sx-transition sx-touch rounded px-3 text-sm ${status === s ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:text-fg'}`}
              >
                {humanize(s)}
              </button>
            ))}
          </div>
        }
      />
      <NotAvailable
        title="Start a new conversation"
        reason="the API requires naming the participants' user ids and a linked entity you can access; staff open partner conversations from the project. Reply inside an existing thread instead."
      />
      {list.isPending ? (
        <LoadingBlock label="Loading conversations" />
      ) : list.isError ? (
        <RequestFailed error={list.error} onRetry={() => void list.refetch()} context="Messages" />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title="No conversations"
          description="A conversation opens when staff add you to a project or request thread."
        />
      ) : (
        <DataTable
          caption="Conversations"
          rows={list.data.items}
          rowKey={(c) => c.id}
          rowLabel={(c) => c.subject}
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              cell: (c) => (
                <span className="flex items-center gap-2">
                  <Link
                    href={`/partner/messages/${c.id}`}
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
              cell: (c) => <DualTime iso={c.lastMessageAt} zone={p.timeZone} />,
            },
            { key: 'state', header: 'State', cell: (c) => (c.closedAt ? 'Closed' : 'Open') },
          ]}
        />
      )}
    </div>
  );
}

export function ConversationView({ conversationId }: { conversationId: string }) {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const conversation = useQuery({
    queryKey: ['partner', 'conversation', conversationId],
    queryFn: () => partnerFetch<ConversationDetail>(`/api/v1/conversations/${conversationId}`),
  });
  const messages = useQuery({
    queryKey: ['partner', 'conversation', conversationId, 'messages'],
    queryFn: () =>
      partnerFetch<Page<MessageDto>>(
        withQuery(`/api/v1/conversations/${conversationId}/messages`, { limit: 100 }),
      ),
    refetchInterval: 20_000,
  });
  const markRead = useMutation({
    mutationFn: () => partnerFetch(`/api/v1/conversations/${conversationId}/read`, { body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['partner', 'conversations'] }),
  });
  useEffect(() => {
    if (messages.data && (conversation.data?.unreadCount ?? 0) > 0) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.data, conversation.data?.unreadCount]);
  const send = useMutation({
    mutationFn: () =>
      partnerFetch<MessageDto>(`/api/v1/conversations/${conversationId}/messages`, {
        body: { body: body.trim(), attachmentFileIds: [] },
      }),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: ['partner', 'conversation', conversationId] });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Message not sent', description: errorMessage(err) }),
  });

  if (conversation.isPending) return <LoadingBlock rows={4} label="Loading conversation" />;
  if (conversation.isError)
    return (
      <RequestFailed
        error={conversation.error}
        onRetry={() => void conversation.refetch()}
        context="Conversation"
      />
    );
  const c = conversation.data;
  const ordered = [...(messages.data?.items ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/partner/messages" className="underline">
            Messages
          </Link>
        }
        title={c.subject}
        description={`${humanize(c.kind)} · ${c.participants
          .filter((x) => !x.leftAt)
          .map((x) => x.name ?? 'Participant')
          .join(', ')}`}
      />
      {c.closedAt ? (
        <Alert tone="info" title="Closed">
          This conversation was closed {formatDateTimeLabel(c.closedAt, p.timeZone)}. Replies are no
          longer accepted.
        </Alert>
      ) : null}
      <Card>
        <CardContent className="space-y-3 pt-5">
          {messages.isPending ? (
            <LoadingBlock label="Loading messages" />
          ) : messages.isError ? (
            <RequestFailed
              error={messages.error}
              onRetry={() => void messages.refetch()}
              context="Messages"
            />
          ) : ordered.length === 0 ? (
            <p className="text-sm text-fg-muted">No messages yet.</p>
          ) : (
            <ol className="space-y-3" aria-label="Messages">
              {ordered.map((m) => {
                const mine = m.senderUserId === p.userId;
                return (
                  <li
                    key={m.id}
                    className={`max-w-[85%] rounded-lg border p-3 text-sm ${mine ? 'ml-auto border-primary/30 bg-primary-soft' : 'border-border bg-bg-elevated'}`}
                  >
                    <p className="text-xs text-fg-muted">
                      {mine ? 'You' : (m.senderName ?? 'Staff')} ·{' '}
                      {formatDateTimeLabel(m.createdAt, p.timeZone)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                    {m.attachmentFileIds.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.attachmentFileIds.map((fileId, i) => (
                          <AttachmentButton key={fileId} fileId={fileId} index={i} />
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
      {!c.closedAt ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate();
          }}
        >
          <Field label="Reply" htmlFor="reply-body">
            {({ id }) => (
              <Textarea
                id={id}
                value={body}
                maxLength={20000}
                onChange={(e) => setBody(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
            Send
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** Opens a short-lived signed link; the server re-checks access on every request. */
function AttachmentButton({ fileId, index }: { fileId: string; index: number }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await openSignedDownload(fileId, 'inline');
        } catch (err) {
          toast({
            tone: 'danger',
            title: 'Attachment not available',
            description: errorMessage(err),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      Attachment {index + 1}
    </Button>
  );
}
