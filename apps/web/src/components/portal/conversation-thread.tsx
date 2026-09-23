'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ConversationDetail, FileDto, MessageDto, Page } from '@simplexd/contracts';
import { Alert, Button, Skeleton, Textarea, formatDateTimeLabel, useToast } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';
import { FileUploader } from './file-uploader';
import { SignedDownloadButton } from './signed-download';

/**
 * Message thread with cursor pagination (newest first from the API, rendered
 * oldest → newest), send with attachments, and mark-read on open. Internal
 * staff messages never reach this component: the API filters them.
 */
export function ConversationThread({
  conversation,
  currentUserId,
  zone,
  canSend,
  cannotSendReason,
}: {
  conversation: ConversationDetail;
  currentUserId: string;
  zone: string;
  canSend: boolean;
  cannotSendReason?: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<FileDto[]>([]);
  const [showUploader, setShowUploader] = useState(false);
  const queryKey = useMemo(() => ['conversation-messages', conversation.id], [conversation.id]);

  const messages = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      portalFetch<Page<MessageDto>>(
        `/api/v1/conversations/${conversation.id}/messages?${new URLSearchParams({ limit: '30', ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });

  const markRead = useMutation({
    mutationFn: () =>
      portalFetch(`/api/v1/conversations/${conversation.id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  });
  useEffect(() => {
    markRead.mutate();
    // Only on open and when new pages arrive at the newest end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, messages.data?.pages[0]?.items[0]?.id]);

  const send = useMutation({
    mutationFn: () =>
      portalFetch<MessageDto>(`/api/v1/conversations/${conversation.id}/messages`, {
        body: {
          body: body.trim(),
          attachmentFileIds: attachments.map((a) => a.id),
          internalOnly: false,
        },
      }),
    onSuccess: () => {
      setBody('');
      setAttachments([]);
      setShowUploader(false);
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const ordered = useMemo(() => {
    const all = messages.data?.pages.flatMap((p) => p.items) ?? [];
    return [...all].reverse();
  }, [messages.data]);
  const names = new Map(conversation.participants.map((p) => [p.userId, p.name ?? 'Participant']));
  const closed = conversation.closedAt !== null;

  return (
    <div className="flex min-h-[50dvh] flex-col gap-4">
      <div className="space-y-3">
        {messages.hasNextPage ? (
          <div className="text-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void messages.fetchNextPage()}
              loading={messages.isFetchingNextPage}
            >
              Load earlier messages
            </Button>
          </div>
        ) : null}
        {messages.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-12 w-3/4" label="Loading messages" />
            <Skeleton className="ml-auto h-12 w-2/3" label="Loading messages" />
          </div>
        ) : messages.isError ? (
          <ErrorState
            title="Messages did not load"
            message={describeError(messages.error).message}
            correlationId={describeError(messages.error).correlationId}
            action={
              <Button type="button" variant="secondary" onClick={() => void messages.refetch()}>
                Try again
              </Button>
            }
          />
        ) : ordered.length === 0 ? (
          <p className="text-sm text-fg-muted">No messages yet. Start the conversation below.</p>
        ) : (
          <ol className="space-y-3" aria-label="Messages">
            {ordered.map((m) => {
              const mine = m.senderUserId === currentUserId;
              return (
                <li key={m.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
                  <article
                    className={`max-w-[85%] rounded-lg border p-3 text-sm ${mine ? 'border-primary/30 bg-primary-soft' : 'border-border bg-bg-elevated'}`}
                  >
                    <p className="mb-1 text-xs text-fg-muted">
                      <span className="font-medium text-fg">
                        {mine ? 'You' : (m.senderName ?? names.get(m.senderUserId ?? '') ?? 'Team')}
                      </span>{' '}
                      · {formatDateTimeLabel(m.createdAt, zone)}
                      {m.editedAt ? ' · edited' : ''}
                    </p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                    {m.attachmentFileIds.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {m.attachmentFileIds.map((id, i) => (
                          <li key={id}>
                            <SignedDownloadButton
                              fileId={id}
                              fileName={`attachment ${i + 1}`}
                              status="clean"
                              label={`Attachment ${i + 1}`}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {closed ? (
        <Alert tone="info" title="Conversation closed">
          This conversation was closed on {formatDateTimeLabel(conversation.closedAt!, zone)}. Start
          a note on the related record to reach the team.
        </Alert>
      ) : !canSend ? (
        <Alert tone="info" title="Sending not available">
          {cannotSendReason ?? 'Your role can read this conversation but not post to it.'}
        </Alert>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim().length > 0) send.mutate();
          }}
          className="space-y-2 border-t border-border pt-4"
        >
          {send.isError ? (
            <ErrorState
              title="Message not sent"
              message={describeError(send.error).message}
              correlationId={describeError(send.error).correlationId}
            />
          ) : null}
          <label className="sr-only" htmlFor={`compose-${conversation.id}`}>
            Message
          </label>
          <Textarea
            id={`compose-${conversation.id}`}
            rows={3}
            maxLength={20_000}
            placeholder="Write a message to the team"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim()) send.mutate();
            }}
          />
          {attachments.length > 0 ? (
            <ul className="flex flex-wrap gap-2 text-xs text-fg-muted">
              {attachments.map((a) => (
                <li key={a.id} className="rounded-full border border-border px-2 py-0.5">
                  {a.originalName}
                  <button
                    type="button"
                    className="ml-2 underline"
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    aria-label={`Remove ${a.originalName}`}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {showUploader ? (
            <FileUploader
              purpose="org_document"
              compact
              label="Choose attachment"
              hint="Attachments are scanned before they can be sent."
              refreshOnSettle={false}
              onUploaded={(f) => {
                if (f.status === 'clean') setAttachments((prev) => [...prev, f]);
                else
                  toast({
                    title: 'Attachment not usable',
                    description: f.statusReason ?? f.status,
                    tone: 'danger',
                  });
              }}
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowUploader((v) => !v)}
              disabled={attachments.length >= 10}
            >
              <Paperclip aria-hidden="true" className="h-4 w-4" />
              {showUploader ? 'Hide attachments' : 'Attach a file'}
            </Button>
            <Button type="submit" loading={send.isPending} disabled={body.trim().length === 0}>
              <Send aria-hidden="true" className="h-4 w-4" />
              Send
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
