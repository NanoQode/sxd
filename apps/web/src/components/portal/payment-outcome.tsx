'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { PaymentVerifyResult } from '@simplexd/contracts';
import { Alert, Button, Skeleton, StatusBadge } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { koboToNaira } from '@/lib/portal/format';
import { ErrorState } from './error-state';

type Tone = 'success' | 'warning' | 'danger' | 'info';

export function outcomeOf(result: PaymentVerifyResult): { tone: Tone; title: string } {
  const status = result.attempt.status;
  if (status === 'successful') return { tone: 'success', title: 'Payment received' };
  if (status === 'pending' || status === 'initialized')
    return { tone: 'info', title: 'Payment not confirmed yet' };
  if (status === 'uncertain') return { tone: 'warning', title: 'Payment needs review' };
  if (status === 'reversed') return { tone: 'warning', title: 'Payment reversed' };
  return {
    tone: 'danger',
    title: status === 'abandoned' ? 'Checkout abandoned' : 'Payment failed',
  };
}

/**
 * Asks the server to verify the attempt with the provider and shows exactly
 * what it decided. A pending outcome offers a re-check; an uncertain outcome
 * tells the customer that finance reconciles it and how to reach support.
 */
export function PaymentOutcome({ attemptId, reference }: { attemptId: string; reference: string }) {
  const verification = useQuery({
    queryKey: ['payment-verify', attemptId],
    queryFn: () =>
      portalFetch<PaymentVerifyResult>(`/api/v1/payment-attempts/${attemptId}/verify`, {
        method: 'POST',
        body: {},
      }),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  if (verification.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <p className="text-sm text-fg-muted">
          Verifying reference {reference} with the payment provider…
        </p>
        <Skeleton className="h-6 w-2/3" label="Verifying payment" />
        <Skeleton className="h-4 w-1/2" label="Verifying payment" />
      </div>
    );
  }
  if (verification.isError || !verification.data) {
    const e = describeError(verification.error);
    return (
      <ErrorState
        title="Could not verify the payment"
        message={`${e.message} Your bank may still have charged you; do not pay again before checking the invoice.`}
        correlationId={e.correlationId}
        action={
          <Button
            type="button"
            variant="secondary"
            onClick={() => void verification.refetch()}
            loading={verification.isFetching}
          >
            Try verification again
          </Button>
        }
      />
    );
  }
  const result = verification.data;
  const { tone, title } = outcomeOf(result);
  const a = result.attempt;
  return (
    <div className="space-y-4">
      <Alert tone={tone} title={title}>
        <p>{result.message}</p>
      </Alert>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-fg-muted">Reference</dt>
          <dd className="font-mono">{a.reference}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Amount</dt>
          <dd>
            {koboToNaira(a.amountKobo)} {a.currency}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">Attempt status</dt>
          <dd>
            <StatusBadge status={a.status} />
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">Invoice status</dt>
          <dd>
            <StatusBadge status={result.invoiceStatus} />
          </dd>
        </div>
        {result.receiptNumber ? (
          <div>
            <dt className="text-fg-muted">Receipt</dt>
            <dd className="font-mono">{result.receiptNumber}</dd>
          </div>
        ) : null}
        {a.failureReason ? (
          <div className="sm:col-span-2">
            <dt className="text-fg-muted">Provider note</dt>
            <dd>{a.failureReason}</dd>
          </div>
        ) : null}
        {a.developmentAdapter ? (
          <div className="sm:col-span-2">
            <dd className="text-xs text-fg-muted">
              Development adapter, not a real gateway. No money moved.
            </dd>
          </div>
        ) : null}
      </dl>
      {a.status === 'uncertain' ? (
        <p className="text-sm text-fg-muted">
          The provider&apos;s answer did not match the attempt exactly, so finance reconciles it by
          hand before anything is marked paid. Quote reference{' '}
          <code className="font-mono">{a.reference}</code> to support; do not pay again.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {a.status === 'pending' || a.status === 'initialized' ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void verification.refetch()}
            loading={verification.isFetching}
          >
            Check again
          </Button>
        ) : null}
        <Link
          href={`/portal/invoices/${a.invoiceId}`}
          className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
        >
          Back to the invoice
        </Link>
      </div>
    </div>
  );
}
