'use client';

import { XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { WorkOrderDto } from '@simplexd/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { ErrorState } from '@/components/portal/error-state';
import { describeTenantError, tenantFetch } from '@/lib/tenant/client';

/**
 * Cancel a ticket the caller reported (allowed until work has started). The
 * reason is required by the workflow and the current version guards against
 * cancelling something that changed in the meantime.
 */
export function CancelTicket({
  ticketId,
  version,
  title,
}: {
  ticketId: string;
  version: number;
  title: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeTenantError> | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setFieldError('Say briefly why you are cancelling (at least 3 characters).');
      document.getElementById('cancel-reason')?.focus();
      return;
    }
    setFieldError(null);
    setFailure(null);
    setBusy(true);
    try {
      await tenantFetch<WorkOrderDto>(`/api/v1/work-orders/${ticketId}/cancel`, {
        body: { reason: trimmed, expectedVersion: version },
      });
      toast({ title: 'Request cancelled', description: title, tone: 'success' });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setFailure(describeTenantError(err));
    } finally {
      setBusy(false);
    }
  }

  const stale =
    failure &&
    (failure.code === 'conflict' ||
      failure.code === 'version_conflict' ||
      failure.code === 'invalid_transition');

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <XCircle aria-hidden="true" className="h-4 w-4" />
        Cancel this request
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent
          title="Cancel this maintenance request?"
          description="The maintenance team stops work on it. You can report the problem again later if it comes back."
        >
          <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
            {failure ? (
              <ErrorState
                title={stale ? 'The request changed in the meantime' : 'Not cancelled'}
                message={
                  stale
                    ? `${failure.message} Close this dialog and reload the page to see its current state.`
                    : failure.message
                }
                correlationId={failure.correlationId}
              />
            ) : null}
            <Field label="Reason" htmlFor="cancel-reason" error={fieldError} required>
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={reason}
                  maxLength={2000}
                  rows={3}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="For example: fixed itself, or reported twice."
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Keep the request
              </Button>
              <Button type="submit" variant="danger" loading={busy} loadingLabel="Cancelling">
                Cancel request
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
