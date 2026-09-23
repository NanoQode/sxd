'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, Textarea } from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';

/**
 * Confirmation dialog for destructive or publication actions. Collects an
 * optional reason, an optional typed confirmation phrase, and shows the
 * server error inline. Non-destructive actions should not use it.
 */
export function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  requireReason = false,
  reasonLabel = 'Reason (recorded in the audit log)',
  confirmText,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  requireReason?: boolean;
  reasonLabel?: string;
  /** When set, the user must type this text to enable the confirm button. */
  confirmText?: string;
  children?: ReactNode;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason('');
      setTyped('');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const reasonOk = !requireReason || reason.trim().length >= 3;
  const typedOk = !confirmText || typed === confirmText;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent title={title} description={description}>
        <div className="space-y-4">
          {error ? (
            <Alert tone="danger" title="Action failed">
              {error}
            </Alert>
          ) : null}
          {children}
          {requireReason ? (
            <Field label={reasonLabel} required hint="At least 3 characters.">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="min-h-20"
                />
              )}
            </Field>
          ) : null}
          {confirmText ? (
            <Field label={`Type "${confirmText}" to confirm`} required>
              {({ id }) => (
                <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              )}
            </Field>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              onClick={confirm}
              disabled={!reasonOk || !typedOk}
              loading={busy}
              loadingLabel="Working"
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
