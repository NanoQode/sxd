'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

function isFuture(localDateTime: string): boolean {
  const t = new Date(localDateTime).getTime();
  return Number.isFinite(t) && t > Date.now();
}

/** Issue a draft RFQ (deadline + suppliers) or invite more suppliers to a sent one. */
export function IssueRfq({
  rfqId,
  mode,
  suppliers,
}: {
  rfqId: string;
  mode: 'issue' | 'invite';
  suppliers: Array<{
    userId: string;
    name: string;
    partnerType: string;
    verificationStatus: string;
  }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deadline, setDeadline] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deadlineIso = deadline ? new Date(deadline).toISOString() : null;
  const ready = mode === 'issue' ? Boolean(deadlineIso) && isFuture(deadline) : picked.length > 0;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'issue') {
        await adminFetch(`/api/v1/rfqs/${rfqId}/issue`, {
          body: { deadlineAt: deadlineIso, supplierUserIds: picked },
        });
        toast({ title: 'RFQ issued', tone: 'success' });
      } else {
        await adminFetch(`/api/v1/rfqs/${rfqId}/invite`, { body: { supplierUserIds: picked } });
        toast({ title: 'Suppliers invited', tone: 'success' });
      }
      setOpen(false);
      setPicked([]);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={mode === 'issue' ? 'primary' : 'secondary'}
        onClick={() => setOpen(true)}
      >
        {mode === 'issue' ? 'Issue RFQ' : 'Invite suppliers'}
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title={mode === 'issue' ? 'Issue the RFQ' : 'Invite suppliers'}
          description={
            mode === 'issue'
              ? 'Suppliers can respond until the deadline. You can also record responses from suppliers without an account.'
              : 'Invited suppliers see only this RFQ and their own response.'
          }
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Could not continue">
                {error}
              </Alert>
            ) : null}
            {mode === 'issue' ? (
              <Field
                label="Response deadline (your device time)"
                required
                hint={deadline && !ready ? 'The deadline must be in the future.' : undefined}
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
            <fieldset>
              <legend className="mb-1 text-sm font-medium">
                Supplier accounts{mode === 'issue' ? ' (optional)' : ''}
              </legend>
              {suppliers.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No partner accounts exist; record responses manually instead.
                </p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
                  {suppliers.map((s) => (
                    <label key={s.userId} className="flex min-h-9 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={picked.includes(s.userId)}
                        onChange={(e) =>
                          setPicked((prev) =>
                            e.target.checked
                              ? [...prev, s.userId]
                              : prev.filter((x) => x !== s.userId),
                          )
                        }
                      />
                      {s.name}{' '}
                      <span className="text-xs text-fg-muted">
                        {humanize(s.partnerType)} · {humanize(s.verificationStatus)}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ready} onClick={() => void run()}>
                {mode === 'issue' ? 'Issue' : 'Invite'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
