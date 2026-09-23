'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Field, Textarea, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/**
 * Reply composer. "Internal note" messages are visible to staff participants
 * only; customers and partners never receive them. Opening the thread marks
 * it read for a participant.
 */
export function ReplyBox({
  conversationId,
  amParticipant,
  closed,
}: {
  conversationId: string;
  amParticipant: boolean;
  closed: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [internalOnly, setInternalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!amParticipant) return;
    void adminFetch(`/api/v1/conversations/${conversationId}/read`, { body: {} }).catch(
      () => undefined,
    );
  }, [conversationId, amParticipant]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/conversations/${conversationId}/messages`, {
        body: { body: body.trim(), internalOnly, attachmentFileIds: [] },
      });
      setBody('');
      toast({ title: internalOnly ? 'Internal note posted' : 'Reply sent', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (closed)
    return (
      <p className="text-sm text-fg-muted">This conversation is closed; replies are disabled.</p>
    );
  if (!amParticipant) {
    return (
      <p className="text-sm text-fg-muted">
        You can read this conversation because your role reads all messages. Join it (Participants)
        to reply.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
      {error ? (
        <Alert tone="danger" title="Not sent">
          {error}
        </Alert>
      ) : null}
      <Field label={internalOnly ? 'Internal note (staff only)' : 'Reply'} required>
        {({ id }) => (
          <Textarea
            id={id}
            value={body}
            maxLength={20_000}
            onChange={(e) => setBody(e.target.value)}
            className={internalOnly ? 'min-h-24 border-warning' : 'min-h-24'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) void send();
            }}
          />
        )}
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={internalOnly}
          onChange={(e) => setInternalOnly(e.target.checked)}
        />
        Internal note: visible to staff participants only
      </label>
      <Button size="sm" loading={busy} disabled={!body.trim()} onClick={() => void send()}>
        {internalOnly ? 'Post internal note' : 'Send reply'}
      </Button>
      <p className="text-xs text-fg-muted">Ctrl/⌘ + Enter sends.</p>
    </div>
  );
}
