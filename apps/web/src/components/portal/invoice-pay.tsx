'use client';

import { CreditCard, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { InvoiceDto, PaymentAttemptDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  NativeSelect,
  useToast,
} from '@simplexd/ui';
import { describeError, newIdempotencyKey, portalFetch } from '@/lib/portal/client';
import { isPositiveKobo, koboToNaira } from '@/lib/portal/format';
import { ErrorState } from './error-state';

/** Paystack Inline v2 (verified snippet in docs/providers/paystack.md). */
const PAYSTACK_INLINE_SCRIPT_URL = 'https://js.paystack.co/v2/inline.js';

declare global {
  interface Window {
    PaystackPop?: new () => {
      resumeTransaction: (
        accessCode: string,
        callbacks?: {
          onSuccess?: (transaction: { reference?: string }) => void;
          onCancel?: () => void;
          onError?: (error: unknown) => void;
        },
      ) => unknown;
    };
  }
}

function loadInlineScript(): Promise<void> {
  if (window.PaystackPop) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PAYSTACK_INLINE_SCRIPT_URL}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('the Paystack checkout script could not load')),
        { once: true },
      );
      return;
    }
    const script = document.createElement('script');
    script.src = PAYSTACK_INLINE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('the Paystack checkout script could not load'));
    document.head.appendChild(script);
  });
}

/**
 * Pay flow: server-created attempt (Idempotency-Key) → Paystack inline popup
 * (resumeTransaction with the access code) or the hosted checkout URL → the
 * return page verifies with the provider. The browser never sees card data
 * and never decides settlement.
 */
export function InvoicePay({
  invoice,
  canPay,
  cannotPayReason,
}: {
  invoice: InvoiceDto;
  canPay: boolean;
  cannotPayReason?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const payable =
    ['issued', 'partially_paid', 'overdue'].includes(invoice.status) &&
    isPositiveKobo(invoice.balanceKobo);
  const [open, setOpen] = useState(false);
  const [installment, setInstallment] = useState<string>('balance');
  const [busy, setBusy] = useState<'idle' | 'creating' | 'opening'>('idle');
  const [error, setError] = useState<{
    message: string;
    correlationId: string | null;
    code: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState<PaymentAttemptDto | null>(null);
  const [key, setKey] = useState('');

  function openDialog() {
    setError(null);
    setAttempt(null);
    setKey(newIdempotencyKey());
    setOpen(true);
  }

  async function createAttempt(): Promise<PaymentAttemptDto | null> {
    setBusy('creating');
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (installment !== 'balance') body.installmentIndex = Number(installment);
      const created = await portalFetch<PaymentAttemptDto>(
        `/api/v1/invoices/${invoice.id}/payment-attempts`,
        {
          idempotencyKey: key,
          body,
        },
      );
      setAttempt(created);
      return created;
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId, code: e.code });
      return null;
    } finally {
      setBusy('idle');
    }
  }

  function goToReturn(reference: string) {
    router.push(`/portal/payments/return?reference=${encodeURIComponent(reference)}`);
  }

  async function payInline() {
    const created = attempt ?? (await createAttempt());
    if (!created) return;
    if (created.provider !== 'paystack' || !created.accessCode) {
      // Development adapter or no access code: the hosted page is the only honest path.
      if (created.authorizationUrl) window.location.assign(created.authorizationUrl);
      else
        setError({
          message: 'The provider returned no checkout link; try again or use bank transfer.',
          correlationId: null,
          code: null,
        });
      return;
    }
    setBusy('opening');
    try {
      await loadInlineScript();
      if (!window.PaystackPop) throw new Error('the Paystack checkout did not initialise');
      const popup = new window.PaystackPop();
      popup.resumeTransaction(created.accessCode, {
        onSuccess: () => goToReturn(created.reference),
        onCancel: () => {
          toast({
            title: 'Checkout closed',
            description: 'Nothing was charged. We will verify the attempt with Paystack anyway.',
          });
          goToReturn(created.reference);
        },
        onError: () => goToReturn(created.reference),
      });
    } catch (err) {
      const e = describeError(err);
      setError({
        message: `${e.message} You can still use the hosted checkout below.`,
        correlationId: e.correlationId,
        code: e.code,
      });
    } finally {
      setBusy('idle');
    }
  }

  async function payHosted() {
    const created = attempt ?? (await createAttempt());
    if (!created) return;
    if (created.authorizationUrl) window.location.assign(created.authorizationUrl);
    else
      setError({
        message: 'The provider returned no checkout link; try again or use bank transfer.',
        correlationId: null,
        code: null,
      });
  }

  if (!payable) return null;
  if (!canPay) {
    return (
      <Alert tone="info" title="Payment not available">
        {cannotPayReason ?? 'Paying invoices needs an owner or member of this organisation.'}
      </Alert>
    );
  }

  const plan = invoice.installmentPlan ?? [];
  return (
    <>
      <Button type="button" onClick={openDialog}>
        <CreditCard aria-hidden="true" className="h-4 w-4" />
        Pay {koboToNaira(invoice.balanceKobo)}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent
          title={`Pay invoice ${invoice.number}`}
          description="You are sent to Paystack's secure checkout; SimplexD never sees your card details. Money counts as received only after the server verifies it with Paystack."
        >
          <div className="space-y-4">
            {error ? (
              <ErrorState
                title={
                  error.code === 'provider_not_configured'
                    ? 'Card payments are not set up yet'
                    : 'Could not start the payment'
                }
                message={
                  error.code === 'provider_not_configured'
                    ? `${error.message} Declare a bank transfer below instead, or contact the team.`
                    : error.message
                }
                correlationId={error.correlationId}
              />
            ) : null}
            {plan.length > 0 ? (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">What to pay</span>
                <NativeSelect
                  value={installment}
                  onChange={(e) => setInstallment(e.target.value)}
                  disabled={attempt !== null}
                >
                  <option value="balance">
                    Outstanding balance ({koboToNaira(invoice.balanceKobo)})
                  </option>
                  {plan.map((p, i) => (
                    <option key={`${p.label}-${i}`} value={String(i)}>
                      {p.label}: {koboToNaira(p.amountKobo)}
                      {p.dueDate ? ` (due ${p.dueDate})` : ''}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : (
              <p className="text-sm">
                Amount: <strong>{koboToNaira(invoice.balanceKobo)}</strong> ({invoice.currency})
              </p>
            )}
            {attempt ? (
              <p className="text-xs text-fg-muted">
                Attempt reference <code className="font-mono">{attempt.reference}</code>
                {attempt.developmentAdapter ? ' · development adapter, not a real gateway' : ''}
              </p>
            ) : null}
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={busy !== 'idle'}
              >
                Not now
              </Button>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void payHosted()}
                  loading={busy === 'creating'}
                >
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                  Hosted checkout
                </Button>
                <Button
                  type="button"
                  onClick={() => void payInline()}
                  loading={busy !== 'idle'}
                  loadingLabel={busy === 'creating' ? 'Preparing' : 'Opening checkout'}
                >
                  Pay with Paystack
                </Button>
              </div>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
