'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { EngagementStatus } from '@simplexd/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from '@/components/portal/error-state';

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
}: {
  id: string;
  version: number;
  status: EngagementStatus;
  availableTransitions: Transition[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState<Transition | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  async function submitTransition() {
    if (!open) return;
    if (open.reasonRequired && reason.trim().length < 3) {
      setError({
        message: 'Please give a short reason; it is recorded in the timeline.',
        correlationId: null,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/service-requests/${id}/transitions`, {
        body: { to: open.to, reason: reason.trim() || undefined, expectedVersion: version },
      });
      toast({ title: `${LABELS[open.to] ?? humanize(open.to)} recorded`, tone: 'success' });
      setOpen(null);
      setReason('');
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
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
                <ErrorState
                  title="Could not apply"
                  message={error.message}
                  correlationId={error.correlationId}
                />
              ) : null}
              {open.reasonRequired ? (
                <Field
                  label="Reason"
                  required
                  hint="Recorded in the request timeline and shared with the team."
                >
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
                <p className="text-sm text-fg-muted">
                  The request will move from {humanize(status)} to {humanize(open.to)}.
                </p>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
                  Keep as is
                </Button>
                <Button
                  variant={open.to === 'cancelled' ? 'danger' : 'primary'}
                  onClick={() => void submitTransition()}
                  loading={busy}
                >
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
