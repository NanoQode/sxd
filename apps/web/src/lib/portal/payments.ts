import type { PaymentAttemptDto } from '@simplexd/contracts';

export type OutcomeTone = 'success' | 'warning' | 'danger' | 'info';

export interface PaymentOutcomeCopy {
  tone: OutcomeTone;
  title: string;
  body: string;
  /** True while the provider has not answered finally; the UI offers a re-check. */
  recheck: boolean;
}

/**
 * Customer copy for a payment attempt, derived only from the status the
 * server recorded after verifying with the provider. Query parameters from a
 * checkout redirect are never trusted for this: a redirect is not settlement.
 */
export function paymentOutcomeCopy(
  attempt: Pick<PaymentAttemptDto, 'status' | 'developmentAdapter' | 'failureReason'>,
): PaymentOutcomeCopy {
  const dev = attempt.developmentAdapter;
  switch (attempt.status) {
    case 'successful':
      return {
        tone: 'success',
        title: 'Payment received',
        body: dev
          ? 'The development adapter reported success and the server matched the reference, amount and currency. No real money moved.'
          : 'Paystack confirmed the payment and the server matched the reference, amount and currency. The receipt is your proof.',
        recheck: false,
      };
    case 'initialized':
    case 'pending':
      return {
        tone: 'info',
        title: 'Payment not confirmed yet',
        body: 'The provider has not confirmed this payment. Check again shortly; do not pay twice.',
        recheck: true,
      };
    case 'uncertain':
      return {
        tone: 'warning',
        title: 'Payment needs review',
        body: 'The provider’s answer did not match the attempt exactly, so finance reconciles it before anything is marked paid. Do not pay again.',
        recheck: false,
      };
    case 'reversed':
      return {
        tone: 'warning',
        title: 'Payment reversed',
        body: 'The provider reversed this payment; the invoice balance reflects that.',
        recheck: false,
      };
    case 'abandoned':
      return {
        tone: 'danger',
        title: 'Checkout abandoned',
        body: 'The checkout was closed before paying. Nothing was charged; you can try again.',
        recheck: false,
      };
    default:
      return {
        tone: 'danger',
        title: 'Payment failed',
        body: attempt.failureReason
          ? `The provider reported: ${attempt.failureReason}. You can try again or pay by bank transfer.`
          : 'The provider reported a failure. You can try again or pay by bank transfer.',
        recheck: false,
      };
  }
}
