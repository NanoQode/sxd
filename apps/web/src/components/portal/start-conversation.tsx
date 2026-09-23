'use client';

import { MessageSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, Field, Textarea } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';
import { LinkButton } from './link-button';

/**
 * Opens (or continues) the customer–team conversation linked to a record.
 * When a conversation already exists the control is a plain link to it;
 * otherwise it creates one with the assigned contact and the first message,
 * then opens the thread. Without an assigned contact there is nobody to
 * address, so the component explains that instead of offering a dead button.
 */
export function StartConversation({
  entityType,
  entityId,
  subject,
  contact,
  existingConversationId,
  canSend,
  cannotSendReason,
}: {
  entityType: 'service_request' | 'project' | 'property';
  entityId: string;
  subject: string;
  contact: { id: string; name: string } | null;
  existingConversationId: string | null;
  canSend: boolean;
  cannotSendReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  if (existingConversationId) {
    return (
      <LinkButton href={`/portal/messages/${existingConversationId}`} variant="secondary" size="sm">
        <MessageSquare aria-hidden="true" className="h-4 w-4" />
        Open the conversation
      </LinkButton>
    );
  }
  if (!contact) {
    return (
      <p className="text-sm text-fg-muted">
        Messaging opens once a project manager is assigned at triage. Until then, add a note and the
        operations team will reply.
      </p>
    );
  }
  if (!canSend) {
    return (
      <p className="text-sm text-fg-muted">
        {cannotSendReason ?? 'Sending messages needs an owner or member of this organisation.'}
      </p>
    );
  }

  async function start() {
    if (message.trim().length === 0) {
      setError({ message: 'Write the first message.', correlationId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await portalFetch<{ id: string }>('/api/v1/conversations', {
        body: {
          kind: 'customer_team',
          subject,
          entityType,
          entityId,
          participantUserIds: [contact!.id],
          initialMessage: message.trim(),
        },
      });
      setOpen(false);
      router.push(`/portal/messages/${created.id}`);
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <MessageSquare aria-hidden="true" className="h-4 w-4" />
        Message {contact.name}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent
          title={`Message ${contact.name}`}
          description={`Starts a conversation about “${subject}”. Replies arrive in Messages and by your notification preferences.`}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
            className="space-y-4"
          >
            {error ? (
              <ErrorState
                title="Could not start the conversation"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field label="Message" required>
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={4}
                  maxLength={20_000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} loadingLabel="Sending">
                Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
