import type { JobRunner } from '../runner';

export function registerPaymentHandlers(runner: JobRunner): void {
  for (const kind of [
    'finance.post_payment',
    'payments.process_provider_event',
    'payments.submit_refund',
    'payments.reconcile_pending',
  ]) {
    runner.register(kind, async ({ log }) => {
      log.info({ kind }, 'payment handler placeholder (implemented in Wave 3)');
    });
  }
}
