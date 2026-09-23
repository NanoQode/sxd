import { getDb } from '@simplexd/db';
import {
  PROCESS_PROVIDER_EVENT_JOB,
  createFinanceRuntime,
  expireQuotes,
  processProviderEvent,
  reconcilePending,
  submitRefund,
  type FinanceRuntime,
} from '@simplexd/finance';
import { NonRetryableJobError, type JobRunner } from '../runner';

/**
 * Payment jobs. Every handler is idempotent: provider events are keyed by
 * their dedupe key and marked processed, settlement is guarded by the
 * allocation dedupe key, refund submission reuses the stored idempotency key
 * and reconciliation re-verifies with the same matcher every path uses.
 */

let runtime: FinanceRuntime | null = null;

function rt(): FinanceRuntime {
  if (!runtime) runtime = createFinanceRuntime({ db: getDb() });
  return runtime;
}

interface OutboxJobPayload {
  event?: { aggregateId?: string; payload?: Record<string, unknown> };
  providerEventId?: string;
  refundId?: string;
}

export function registerPaymentHandlers(runner: JobRunner): void {
  runner.register(PROCESS_PROVIDER_EVENT_JOB, async ({ job, log }) => {
    const payload = job.payload as OutboxJobPayload;
    const providerEventId = payload.providerEventId ?? payload.event?.aggregateId;
    if (!providerEventId)
      throw new NonRetryableJobError('provider event job without providerEventId');
    const result = await processProviderEvent(rt(), providerEventId, {
      correlationId: job.correlationId ?? undefined,
    });
    log.info({ providerEventId, actions: result.actions }, 'provider event processed');
  });

  runner.register('payments.submit_refund', async ({ job, log }) => {
    const payload = job.payload as OutboxJobPayload;
    const refundId = payload.refundId ?? payload.event?.aggregateId;
    if (!refundId) throw new NonRetryableJobError('refund job without refundId');
    const refund = await submitRefund(rt(), refundId, {
      correlationId: job.correlationId ?? undefined,
    });
    log.info(
      { refundId, status: refund.status, providerStatus: refund.providerStatus },
      'refund submitted',
    );
  });

  runner.register('payments.reconcile_pending', async ({ job, log }) => {
    const summary = await reconcilePending(rt(), { correlationId: job.correlationId ?? undefined });
    log.info(summary, 'payment reconciliation run');
  });

  runner.register('engagements.expire_quotes', async ({ log }) => {
    const expired = await expireQuotes(rt());
    if (expired.length > 0) log.info({ expired: expired.length }, 'quotes expired');
  });

  // Posting happens inside the settlement transaction; this legacy job only confirms the event was relayed.
  runner.register('finance.post_payment', async ({ job, log }) => {
    const payload = job.payload as OutboxJobPayload;
    log.info(
      { paymentAttemptId: payload.event?.aggregateId },
      'payment already posted at settlement',
    );
  });
}
