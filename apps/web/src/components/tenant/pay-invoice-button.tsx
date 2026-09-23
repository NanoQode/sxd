'use client';

import { CreditCard } from 'lucide-react';
import { useRef, useState } from 'react';
import type { PaymentAttemptDto } from '@simplexd/contracts';
import { Alert, Button } from '@simplexd/ui';
import { describeTenantError, newIdempotencyKey, tenantFetch } from '@/lib/tenant/client';

/**
 * Starts a hosted checkout for one of the tenant's own invoices. The server
 * creates the attempt (the invoice's addressee may pay it) and returns the
 * provider's checkout address; card details never touch SimplexD. Coming back
 * from checkout is not settlement: the callback verifies with the provider and
 * returns to the balances page, which shows the verified result.
 */
export function PayInvoiceButton({
  invoiceId,
  invoiceNumber,
  amountLabel,
}: {
  invoiceId: string;
  invoiceNumber: string;
  amountLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One key per click intent, reused if the person retries after a network error.
  const keyRef = useRef<string | null>(null);

  async function pay() {
    setBusy(true);
    setProblem(null);
    keyRef.current ??= newIdempotencyKey();
    try {
      const attempt = await tenantFetch<PaymentAttemptDto>(
        `/api/v1/invoices/${invoiceId}/payment-attempts`,
        { method: 'POST', body: {}, idempotencyKey: keyRef.current },
      );
      if (!attempt.authorizationUrl) {
        setProblem('The payment provider did not return a checkout page. Please try again later.');
        return;
      }
      window.location.assign(attempt.authorizationUrl);
    } catch (err) {
      const described = describeTenantError(err, 'The payment could not be started.');
      setProblem(
        described.correlationId
          ? `${described.message} (reference ${described.correlationId})`
          : described.message,
      );
      keyRef.current = null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        onClick={pay}
        disabled={busy}
        aria-label={`Pay invoice ${invoiceNumber} (${amountLabel})`}
      >
        <CreditCard aria-hidden="true" className="h-4 w-4" />
        {busy ? 'Opening checkout…' : `Pay ${amountLabel}`}
      </Button>
      {problem ? (
        <Alert tone="danger" className="max-w-sm text-sm">
          {problem}
        </Alert>
      ) : null}
    </div>
  );
}
