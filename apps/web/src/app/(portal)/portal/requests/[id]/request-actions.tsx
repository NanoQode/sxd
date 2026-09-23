'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { EngagementStatus } from '@simplexd/contracts';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Textarea, humanize, useToast } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

interface Transition {
  to: EngagementStatus;
  reasonRequired: boolean;
  effect: string | null;
}

const LABELS: Record<string, string> = {
  cancelled: 'Cancel request',
  paused: 'Pause request',
  in_progress: 'Resume request',
};

export function RequestActions({
  id,
  version,
  status,
  availableTransitions,
  mode,
}: {
  id: string;
  version: number;
  status: EngagementStatus;
  availableTransitions: Transition[];
  mode: 'transitions' | 'note';
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState<Transition | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitTransition() {
    if (!open) return;
    if (open.reasonRequired && reason.trim().length < 3) {
      setError('Please give a short reason; it is recorded in the timeline.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/service-requests/${id}/transitions`, {
        method: 'POST',
        body: { to: open.to, reason: reason.trim() || undefined, expectedVersion: version },
      });
      toast({ title: `${LABELS[open.to] ?? humanize(open.to)} recorded`, tone: 'success' });
      setOpen(null);
      setReason('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitNote() {
    if (note.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/service-requests/${id}/notes`, { method: 'POST', body: { body: note.trim() } });
      setNote('');
      toast({ title: 'Note added', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'note') {
    const closed = status === 'completed' || status === 'cancelled' || status === 'rejected';
    if (closed) return <p className="text-sm text-fg-muted">This request is closed; notes are read-only.</p>;
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitNote();
        }}
        className="space-y-2"
      >
        {error ? (
          <Alert tone="danger" title="Could not add note">
            {error}
          </Alert>
        ) : null}
        <Field label="Add a note for the team">
          {({ id: fieldId }) => (
            <Textarea id={fieldId} rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </Field>
        <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={note.trim().length === 0}>
          Add note
        </Button>
      </form>
    );
  }

  if (availableTransitions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {availableTransitions.map((t) => (
        <Button
          key={t.to}
          variant={t.to === 'cancelled' ? 'danger' : 'secondary'}
          onClick={() => {
            setError(null);
            setReason('');
            setOpen(t);
          }}
        >
          {LABELS[t.to] ?? humanize(t.to)}
        </Button>
      ))}
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? (
          <DialogContent
            title={LABELS[open.to] ?? humanize(open.to)}
            description={open.effect ?? undefined}
            size="sm"
          >
            <div className="space-y-3">
              {error ? (
                <Alert tone="danger" title="Could not apply">
                  {error}
                </Alert>
              ) : null}
              {open.reasonRequired ? (
                <Field label="Reason" required hint="Recorded in the request timeline and shared with the team.">
                  {({ id: fieldId, describedBy }) => (
                    <Textarea
                      id={fieldId}
                      aria-describedby={describedBy}
                      rows={3}
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  )}
                </Field>
              ) : (
                <p className="text-sm text-fg-muted">The request will move from {humanize(status)} to {humanize(open.to)}.</p>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
                  Keep as is
                </Button>
                <Button variant={open.to === 'cancelled' ? 'danger' : 'primary'} onClick={() => void submitTransition()} loading={busy}>
                  Confirm
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
