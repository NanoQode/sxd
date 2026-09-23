import { notFound } from 'next/navigation';
import { DEV_ADAPTER_LABEL } from '@simplexd/integrations/payments';
import { getDevPaymentProvider } from '@simplexd/finance';

export const dynamic = 'force-dynamic';

/**
 * Development checkout page for the labelled development adapter. It stands
 * in for Paystack's hosted checkout locally: the buttons choose the outcome
 * the adapter will report to `verify()`, then the browser is sent to the
 * callback URL, where the server verifies before anything settles. Refuses
 * to render in production.
 */
export default async function DevPaystackCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; error?: string }>;
}) {
  if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') notFound();
  const { reference, error } = await searchParams;
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const provider = getDevPaymentProvider(appUrl, process.env.APP_ENV);
  const known = reference ? await provider.verify(reference) : null;
  const notFoundRef = Boolean(reference) && known?.providerStatus === 'unknown';

  return (
    <main style={{ maxWidth: 560, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <p
        role="status"
        style={{ background: '#fff4e5', border: '1px solid #f0b060', padding: '0.75rem 1rem', borderRadius: 8, fontWeight: 600 }}
      >
        Development adapter — not a real gateway ({DEV_ADAPTER_LABEL}). No money moves here.
      </p>
      <h1 style={{ fontSize: '1.5rem', marginTop: '1.5rem' }}>Simulated Paystack checkout</h1>
      {!reference && <p>Missing <code>reference</code>. Start a payment from an invoice in the portal.</p>}
      {reference && notFoundRef && (
        <p>
          Reference <code>{reference}</code> is not known to this process&apos;s development adapter. Create the attempt
          again from the invoice (the adapter keeps simulated transactions in memory per process).
        </p>
      )}
      {reference && known && !notFoundRef && (
        <>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1rem' }}>
            <dt>Reference</dt>
            <dd><code>{reference}</code></dd>
            <dt>Amount</dt>
            <dd>{known.currency} {known.amountKobo === null ? '?' : (Number(known.amountKobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</dd>
            <dt>Provider status</dt>
            <dd>{known.providerStatus}</dd>
          </dl>
          {error && <p style={{ color: '#b00020' }}>{error}</p>}
          <form method="post" action="/dev/paystack-checkout/simulate" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.5rem' }}>
            <input type="hidden" name="reference" value={reference} />
            <button type="submit" name="outcome" value="success" style={buttonStyle('#0a7d32')}>Simulate success</button>
            <button type="submit" name="outcome" value="failed" style={buttonStyle('#b00020')}>Simulate failure</button>
            <button type="submit" name="outcome" value="abandoned" style={buttonStyle('#555')}>Simulate abandon</button>
          </form>
          <p style={{ marginTop: '1.5rem', color: '#555', fontSize: '0.9rem' }}>
            After choosing an outcome you are redirected to the callback URL. The callback only asks the server to verify;
            settlement happens only when the adapter reports success with the exact reference, amount and currency.
          </p>
        </>
      )}
    </main>
  );
}

function buttonStyle(background: string): React.CSSProperties {
  return { background, color: 'white', border: 0, padding: '0.6rem 1rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 };
}
