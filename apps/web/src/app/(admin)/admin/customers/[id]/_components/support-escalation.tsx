'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, Textarea, humanize, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

export function SupportEscalation({
  organizationId,
  members,
  canManage,
}: {
  organizationId: string;
  members: Array<{ userId: string; name: string; role: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [participants, setParticipants] = useState<string[]>(members.filter((m) => m.role === 'owner').map((m) => m.userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{ id: string }>('/api/v1/conversations', {
        body: {
          kind: 'support_ticket',
          subject: subject.trim(),
          organizationId,
          participantUserIds: participants,
          initialMessage: message.trim() || undefined,
        },
      });
      toast({ title: 'Support ticket opened', tone: 'success' });
      setOpen(false);
      router.push(`/admin/messages/${res.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return <p className="text-fg-muted">Opening tickets needs support.tickets.manage or customers.manage.</p>;
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={members.length === 0} title={members.length === 0 ? 'The organisation has no members to message' : undefined}>
        Open support ticket
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent title="Open a support ticket" description="Creates a support-ticket conversation with the selected members. You are added as a participant.">
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Could not open ticket">
                {error}
              </Alert>
            ) : null}
            <Field label="Subject" required>
              {({ id }) => <Input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />}
            </Field>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Participants</legend>
              {members.map((m) => (
                <label key={m.userId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={participants.includes(m.userId)}
                    onChange={(e) => setParticipants(e.target.checked ? [...participants, m.userId] : participants.filter((p) => p !== m.userId))}
                  />
                  {m.name} <span className="text-fg-muted">({humanize(m.role)})</span>
                </label>
              ))}
            </fieldset>
            <Field label="First message (optional)">
              {({ id }) => <Textarea id={id} value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-20" maxLength={20000} />}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={subject.trim().length < 2 || participants.length === 0} onClick={() => void create()}>
                Open ticket
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
