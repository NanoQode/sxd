import { receiveProviderWebhook } from '@simplexd/finance';
import { json, route } from '@/lib/api/respond';
import { getFinanceRuntime } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/webhooks/paystack — unauthenticated endpoint authenticated by
 * the HMAC-SHA512 signature over the exact raw body. Authentic events are
 * persisted and deduplicated before the 200 acknowledgement; processing
 * runs in the worker (`payments.process_provider_event`). Invalid signatures
 * get 401 and are recorded without being processed.
 */
export const POST = route(async (req, { correlationId }) => {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const receipt = await receiveProviderWebhook(getFinanceRuntime(), {
    rawBody,
    signatureHeader: req.headers.get('x-paystack-signature'),
    headers,
    correlationId,
  });
  return json({ received: receipt.received, duplicate: receipt.duplicate }, { status: receipt.status, correlationId });
});
