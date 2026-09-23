'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, Textarea, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** Staff-only conversation (kind `internal`). Customer and partner conversations start from the customer or request page. */
export function NewInternalConversation({ staff, me }: { staff: Array<{ userId: string; name: string }>; me: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = staff.filter((s) => s.userId !== me);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{ id: string }>('/api/v1/conversations', {
        body: { kind: 'internal', subject: subject.trim(), participantUserIds: picked, initialMessage: message.trim() || undefined },
      });
      toast({ title: 'Conversation started', tone: 'success' });
      setOpen(false);
      router.push(`/admin/messages/${res.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={others.length === 0}>
        New internal conversation
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent title="New internal conversation" description="Staff only. You are added automatically.">
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Could not start">
                {error}
              </Alert>
            ) : null}
            <Field label="Subject" required>
              {({ id }) => <Input id={id} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />}
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Participants</legend>
              <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
                {others.map((s) => (
                  <label key={s.userId} className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={picked.includes(s.userId)}
                      onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, s.userId] : prev.filter((x) => x !== s.userId)))}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="First message">
              {({ id }) => <Textarea id={id} value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-20" />}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={subject.trim().length < 2 || picked.length === 0} onClick={() => void create()}>
                Start
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
