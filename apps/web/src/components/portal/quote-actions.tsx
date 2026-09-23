'use client';

import Link from 'next/link';
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
  Textarea,
  useToast,
} from '@simplexd/ui';
import { describeError, newIdempotencyKey, portalFetch } from '@/lib/portal/client';
import { CUSTOMER_TERMS_PATH, CUSTOMER_TERMS_VERSION } from '@/lib/portal/terms';
import { ErrorState } from './error-state';

interface AcceptResult {
  quote: { id: string; status: string };
  invoiceId: string | null;
  engagementStatus: 'awaiting_payment' | 'in_progress';
}

/**
 * Accept (signature name + terms checkbox, Idempotency-Key) or reject (reason)
 * an issued quote. The key is created when the dialog opens so a retry after
 * a network failure replays instead of double-accepting.
 */
export function QuoteActions({
  quoteId,
  versionId,
  versionNumber,
  totalLabel,
  canAccept,
  cannotAcceptReason,
}: {
  quoteId: string;
  versionId: string;
  versionNumber: number;
  totalLabel: string;
  canAccept: boolean;
  cannotAcceptReason?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<'accept' | 'reject' | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [signature, setSignature] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  function open(next: 'accept' | 'reject') {
    setError(null);
    setMode(next);
    if (next === 'accept') setIdempotencyKey(newIdempotencyKey());
  }

  async function accept() {
    if (signature.trim().length < 2) {
      setError({ message: 'Type your full name as the signature.', correlationId: null });
      return;
    }
    if (!agreed) {
      setError({
        message: 'Confirm that you accept the terms of engagement.',
        correlationId: null,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await portalFetch<AcceptResult>(`/api/v1/quotes/${quoteId}/accept`, {
        idempotencyKey,
        body: {
          quoteVersionId: versionId,
          signatureName: signature.trim(),
          termsVersion: CUSTOMER_TERMS_VERSION,
          acceptTerms: true,
        },
      });
      toast({
        title: 'Quote accepted',
        description:
          result.engagementStatus === 'awaiting_payment'
            ? 'An invoice has been issued; pay it to start the work.'
            : 'Work can start without an upfront payment.',
        tone: 'success',
      });
      setMode(null);
      if (result.invoiceId) router.push(`/portal/invoices/${result.invoiceId}`);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (reason.trim().length < 3) {
      setError({
        message: 'Give a short reason so the team can revise the quote.',
        correlationId: null,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/quotes/${quoteId}/reject`, {
        body: { quoteVersionId: versionId, reason: reason.trim() },
      });
      toast({
        title: 'Quote rejected',
        description: 'The team has been notified with your reason.',
        tone: 'success',
      });
      setMode(null);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {canAccept ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => open('accept')}>
            Accept quote v{versionNumber}
          </Button>
          <Button type="button" variant="secondary" onClick={() => open('reject')}>
            Reject with reason
          </Button>
        </div>
      ) : (
        <Alert tone="info" title="Acceptance not available">
          {cannotAcceptReason ??
            'Accepting a quote needs an owner or approver of this organisation.'}
        </Alert>
      )}

      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        {mode === 'accept' ? (
          <DialogContent
            title={`Accept quote v${versionNumber}`}
            description={`Total ${totalLabel}. Your signature name, the terms version, your IP address hash and browser are recorded with the acceptance.`}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void accept();
              }}
              className="space-y-4"
            >
              {error ? (
                <ErrorState
                  title="Could not accept"
                  message={error.message}
                  correlationId={error.correlationId}
                />
              ) : null}
              <Field
                label="Signature (your full name)"
                required
                hint="Typed name as an electronic signature."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                    autoComplete="name"
                    maxLength={160}
                    required
                  />
                )}
              </Field>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  required
                />
                <span>
                  I accept the{' '}
                  <Link
                    href={CUSTOMER_TERMS_PATH}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    terms of engagement
                  </Link>{' '}
                  (version <code className="font-mono text-xs">{CUSTOMER_TERMS_VERSION}</code>) and
                  the scope, exclusions and total shown above.
                </span>
              </label>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setMode(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy} loadingLabel="Recording acceptance">
                  Accept and continue
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : mode === 'reject' ? (
          <DialogContent
            title={`Reject quote v${versionNumber}`}
            description="The quote is closed and the team is asked to revise it."
            size="sm"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void reject();
              }}
              className="space-y-4"
            >
              {error ? (
                <ErrorState
                  title="Could not reject"
                  message={error.message}
                  correlationId={error.correlationId}
                />
              ) : null}
              <Field label="Reason" required hint="Shared with the team.">
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={3}
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                  />
                )}
              </Field>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setMode(null)} disabled={busy}>
                  Keep the quote
                </Button>
                <Button type="submit" variant="danger" loading={busy}>
                  Reject quote
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
