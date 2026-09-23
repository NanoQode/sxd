import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CALLBACK_PATH, getDevPaymentProvider } from '@simplexd/finance';
import { DEV_CHECKOUT_PATH } from '@simplexd/integrations/payments';

export const dynamic = 'force-dynamic';

const formSchema = z.object({
  reference: z.string().regex(/^[A-Za-z0-9.=-]{1,100}$/),
  outcome: z.enum(['success', 'failed', 'abandoned']),
});

/**
 * POST /dev/paystack-checkout/simulate — drives `DevPaymentProvider.simulate`
 * for the local checkout page and redirects to the callback URL. Refused in
 * production; never a real gateway.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 });
  }
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const form = await req.formData();
  const parsed = formSchema.safeParse({ reference: form.get('reference'), outcome: form.get('outcome') });
  if (!parsed.success) return new NextResponse('Bad request', { status: 400 });
  const provider = getDevPaymentProvider(appUrl, process.env.APP_ENV);
  try {
    provider.simulate(parsed.data.reference, parsed.data.outcome);
  } catch (err) {
    const back = new URL(DEV_CHECKOUT_PATH, appUrl);
    back.searchParams.set('reference', parsed.data.reference);
    back.searchParams.set('error', err instanceof Error ? err.message : 'simulation failed');
    return NextResponse.redirect(back, 303);
  }
  const callback = new URL(CALLBACK_PATH, appUrl);
  callback.searchParams.set('reference', parsed.data.reference);
  return NextResponse.redirect(callback, 303);
}
