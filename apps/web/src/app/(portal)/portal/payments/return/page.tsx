import type { Metadata } from 'next';
import Link from 'next/link';
import { uuidSchema } from '@simplexd/contracts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { financeActorForPage, findAttemptByReference } from '@/lib/portal/server/finance';
import { PaymentOutcome } from '@/components/portal/payment-outcome';
import { getFinanceRuntime } from '@/server/finance/runtime';
import { getPaymentAttempt } from '@simplexd/finance';

export const metadata: Metadata = { title: 'Payment result' };
export const dynamic = 'force-dynamic';

/**
 * Where checkout returns to. The page resolves the attempt by its reference
 * (row-level security keeps it to the caller's organisation), then the
 * client asks the server to verify with the provider and shows the outcome.
 */
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; attempt?: string; trxref?: string }>;
}) {
  const { reference: referenceParam, attempt: attemptParam, trxref } = await searchParams;
  const reference = referenceParam ?? trxref ?? null;
  const identity = await requireSignedIn(
    `/portal/payments/return?${new URLSearchParams({ ...(reference ? { reference } : {}), ...(attemptParam ? { attempt: attemptParam } : {}) }).toString()}`,
  );
  let attempt: { id: string; reference: string } | null = null;
  if (attemptParam && uuidSchema.safeParse(attemptParam).success) {
    attempt = await getPaymentAttempt(
      getFinanceRuntime(),
      financeActorForPage(identity),
      attemptParam,
    ).catch(() => null);
  } else if (reference && /^[A-Za-z0-9.=-]{1,100}$/.test(reference)) {
    attempt = await findAttemptByReference(identity, reference);
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/invoices" className="underline">
            Invoices
          </Link>
        }
        title="Payment result"
        description="Coming back from checkout is not a payment. The result below is what the server verified with the provider just now."
      />
      <Card>
        <CardHeader>
          <CardTitle>Verification</CardTitle>
          <CardDescription>
            Settlement happens only when the provider reports success and the reference, amount and
            currency match the attempt exactly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!attempt ? (
            <EmptyState
              tone="warning"
              title="Payment attempt not found"
              description={
                reference || attemptParam
                  ? 'No attempt with that reference belongs to your organisation. If you were charged, quote the reference to support; do not pay again.'
                  : 'Open an invoice and start a payment to get here.'
              }
              action={
                <Link
                  href="/portal/invoices"
                  className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
                >
                  Go to invoices
                </Link>
              }
            />
          ) : (
            <PaymentOutcome attemptId={attempt.id} reference={attempt.reference} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
