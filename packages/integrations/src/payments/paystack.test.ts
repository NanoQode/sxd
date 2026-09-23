import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors';
import { fakeFetch, fixtureJson, fixtureText } from './fixtures.test-helpers';
import { PAYSTACK_BASE_URL, PaystackPaymentProvider } from './paystack';
import { computeWebhookSignature } from './signature';

const SECRET = 'sk_test_fixture_e5';

function provider(
  fetch: ReturnType<typeof fakeFetch>,
  extra: Partial<ConstructorParameters<typeof PaystackPaymentProvider>[0]> = {},
) {
  return new PaystackPaymentProvider({
    secretKey: SECRET,
    fetchImpl: fetch.impl,
    retryDelayMs: 0,
    sleep: async () => {},
    ...extra,
  });
}

describe('PaystackPaymentProvider construction', () => {
  it('detects the environment from the key prefix and refuses mismatches', () => {
    expect(provider(fakeFetch([])).environment).toBe('test');
    expect(
      new PaystackPaymentProvider({ secretKey: 'sk_live_abc', fetchImpl: fakeFetch([]).impl })
        .environment,
    ).toBe('live');
    expect(() => provider(fakeFetch([]), { environment: 'live' })).toThrow(/does not match/);
    expect(() => new PaystackPaymentProvider({ secretKey: 'not-a-key' })).toThrow(/sk_test_/);
    expect(() => provider(fakeFetch([]), { publicKey: 'pk_live_abc' })).toThrow(/public key/);
  });
});

describe('PaystackPaymentProvider.initialize', () => {
  it('posts the documented request shape with a bearer secret and integer kobo', async () => {
    const fetch = fakeFetch([{ status: 200, body: fixtureJson('initialize-response.json') }]);
    const p = provider(fetch);
    // The fixture echoes reference nms6uvr1pl, so request the same reference.
    const result = await p.initialize({
      reference: 'nms6uvr1pl',
      amountKobo: 40333n,
      currency: 'NGN',
      email: 'customer@email.com',
      callbackUrl: 'https://app.example.com/pay/callback',
      metadata: { invoiceId: 'inv-1' },
      channels: ['card', 'bank_transfer'],
    });
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(`${PAYSTACK_BASE_URL}/transaction/initialize`);
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(call.headers['Content-Type']).toBe('application/json');
    const body = call.body as Record<string, unknown>;
    expect(body.amount).toBe(40333);
    expect(Number.isInteger(body.amount)).toBe(true);
    expect(body.reference).toBe('nms6uvr1pl');
    expect(body.currency).toBe('NGN');
    expect(body.email).toBe('customer@email.com');
    expect(body.callback_url).toBe('https://app.example.com/pay/callback');
    expect(body.channels).toEqual(['card', 'bank_transfer']);
    expect(body.metadata).toEqual({ invoiceId: 'inv-1' });
    expect(result).toEqual({
      authorizationUrl: 'https://checkout.paystack.com/nkdks46nymizns7',
      accessCode: 'nkdks46nymizns7',
      providerReference: 'nms6uvr1pl',
    });
  });

  it('rejects bad input before any network call', async () => {
    const fetch = fakeFetch([{ status: 200, body: fixtureJson('initialize-response.json') }]);
    const p = provider(fetch);
    const base = {
      reference: 'ok-ref.1',
      amountKobo: 1000n,
      currency: 'NGN',
      email: 'a@b.co',
      callbackUrl: 'https://x.example/cb',
    };
    await expect(p.initialize({ ...base, amountKobo: 0n })).rejects.toThrow(/positive/);
    await expect(p.initialize({ ...base, reference: 'bad ref!' })).rejects.toThrow(/reference/);
    await expect(p.initialize({ ...base, currency: 'XXX' })).rejects.toThrow(/currency/);
    await expect(p.initialize({ ...base, callbackUrl: 'not-a-url' })).rejects.toThrow(
      /callbackUrl/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('maps a 400 duplicate reference to invalid_request and does not retry POSTs', async () => {
    const fetch = fakeFetch([{ status: 400, body: fixtureJson('error-duplicate-reference.json') }]);
    const p = provider(fetch);
    const error = await p
      .initialize({
        reference: 'dup',
        amountKobo: 1000n,
        currency: 'NGN',
        email: 'a@b.co',
        callbackUrl: 'https://x.example/cb',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    const pe = error as ProviderError;
    expect(pe.code).toBe('invalid_request');
    expect(pe.providerCode).toBe('duplicate_reference');
    expect(pe.httpStatus).toBe(400);
    expect(fetch.calls).toHaveLength(1);
  });

  it('refuses a response whose reference differs from the request', async () => {
    const fetch = fakeFetch([{ status: 200, body: fixtureJson('initialize-response.json') }]);
    await expect(
      provider(fetch).initialize({
        reference: 'other-ref',
        amountKobo: 1000n,
        currency: 'NGN',
        email: 'a@b.co',
        callbackUrl: 'https://x.example/cb',
      }),
    ).rejects.toThrow(/different reference/);
  });
});

describe('PaystackPaymentProvider.verify', () => {
  it('maps the official verify sample to a VerifyResult with sanitized raw data', async () => {
    const fetch = fakeFetch([{ status: 200, body: fixtureJson('verify-success.json') }]);
    const result = await provider(fetch).verify('re4lyvq3s3');
    expect(fetch.calls[0]!.url).toBe(`${PAYSTACK_BASE_URL}/transaction/verify/re4lyvq3s3`);
    expect(fetch.calls[0]!.method).toBe('GET');
    expect(result.providerStatus).toBe('success');
    expect(result.amountKobo).toBe(40333n);
    expect(result.currency).toBe('NGN');
    expect(result.providerReference).toBe('re4lyvq3s3');
    expect(result.providerTransactionId).toBe('4099260516');
    expect(result.feesKobo).toBe(10283n);
    expect(result.channel).toBe('card');
    expect(result.paidAt).toBe('2024-08-22T09:15:02.000Z');
    expect(result.environment).toBe('test');
    const auth = result.raw.authorization as Record<string, unknown>;
    expect(auth.authorization_code).toBeUndefined();
    expect(auth.signature).toBeUndefined();
    expect(auth.bin).toBeUndefined();
    expect(auth.last4).toBe('4081');
    expect(result.raw.ip_address).toBeUndefined();
    expect(result.raw.log).toBeUndefined();
    expect(JSON.stringify(result.raw)).not.toContain('AUTH_uh8bcl3zbn');
  });

  it('returns unknown (not a failure) when the reference is not found', async () => {
    const fetch = fakeFetch([
      { status: 404, body: { status: false, message: 'Transaction reference not found' } },
    ]);
    const result = await provider(fetch).verify('missing-ref');
    expect(result.providerStatus).toBe('unknown');
    expect(result.amountKobo).toBeNull();
    expect(result.raw.not_found).toBe(true);
  });

  it('retries idempotent GETs on 5xx and then succeeds', async () => {
    const fetch = fakeFetch([
      { status: 503, body: { status: false, message: 'upstream unavailable' } },
      { status: 200, body: fixtureJson('verify-success.json') },
    ]);
    const result = await provider(fetch).verify('re4lyvq3s3');
    expect(result.providerStatus).toBe('success');
    expect(fetch.calls).toHaveLength(2);
  });

  it('maps 401 to an auth error that never contains the secret', async () => {
    const fetch = fakeFetch([
      { status: 401, body: { status: false, message: `Invalid key ${SECRET} Bearer ${SECRET}` } },
    ]);
    const error = (await provider(fetch)
      .verify('abc')
      .catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('auth');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('[redacted]');
    expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
    expect(error.customerMessage).not.toMatch(/sk_|Invalid key/);
  });

  it('times out with a network error and honours the abort signal', async () => {
    const hanging = async (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const p = new PaystackPaymentProvider({
      secretKey: SECRET,
      fetchImpl: hanging,
      timeoutMs: 15,
      maxRetries: 0,
    });
    const error = (await p.verify('slow').catch((e: unknown) => e)) as ProviderError;
    expect(error.code).toBe('network');
    expect(error.message).toMatch(/timed out/);
    expect(error.retryable).toBe(true);
  });
});

describe('PaystackPaymentProvider refunds', () => {
  it('creates a refund with the documented body and maps the pending response', async () => {
    const fetch = fakeFetch([{ status: 200, body: fixtureJson('refund-create-response.json') }]);
    const result = await provider(fetch).createRefund({
      providerReference: 'T685312322670591',
      amountKobo: 10000n,
      currency: 'NGN',
      reason: 'Service cancelled before start',
      idempotencyKey: 'refund-42',
    });
    const call = fetch.calls[0]!;
    expect(call.url).toBe(`${PAYSTACK_BASE_URL}/refund`);
    expect(call.method).toBe('POST');
    const body = call.body as Record<string, unknown>;
    expect(body.transaction).toBe('T685312322670591');
    expect(body.amount).toBe(10000);
    expect(body.currency).toBe('NGN');
    expect(body.customer_note).toBe('Service cancelled before start');
    expect(body.merchant_note).toContain('refund-42');
    expect(result.providerRefundId).toBe('3018284');
    expect(result.status).toBe('pending');
    expect(result.amountKobo).toBe(10000n);
    expect(result.transactionReference).toBe('T685312322670591');
  });

  it('fetches a refund and maps processed', async () => {
    const fetch = fakeFetch([{ status: 200, body: fixtureJson('refund-fetch-response.json') }]);
    const result = await provider(fetch).getRefund('1');
    expect(fetch.calls[0]!.url).toBe(`${PAYSTACK_BASE_URL}/refund/1`);
    expect(result.status).toBe('processed');
    expect(result.amountKobo).toBe(500000n);
    expect(result.transactionReference).toBe('1641');
  });

  it('requires a reference and an idempotency key', async () => {
    const p = provider(fakeFetch([]));
    await expect(p.createRefund({ reason: 'x', idempotencyKey: 'k' })).rejects.toThrow(/reference/);
    await expect(
      p.createRefund({ reference: 'r', reason: 'x', idempotencyKey: '' }),
    ).rejects.toThrow(/idempotency/);
  });
});

describe('PaystackPaymentProvider.testConnection', () => {
  it('treats a 404 for the sentinel reference as an accepted key', async () => {
    const fetch = fakeFetch([
      { status: 404, body: { status: false, message: 'Transaction reference not found' } },
    ]);
    const result = await provider(fetch).testConnection();
    expect(result.ok).toBe(true);
    expect(result.environmentDetected).toBe('test');
    expect(fetch.calls[0]!.url).toMatch(/\/transaction\/verify\/simplexd-connection-check-/);
  });

  it('reports a rejected key without leaking it', async () => {
    const fetch = fakeFetch([{ status: 401, body: fixtureJson('error-unauthorized.json') }]);
    const result = await provider(fetch).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected/);
    expect(result.message).not.toContain(SECRET);
  });
});

describe('PaystackPaymentProvider webhooks', () => {
  const body = fixtureText('charge-success.json');
  const p = provider(fakeFetch([]));

  it('accepts a valid HMAC-SHA512 signature over the raw body', () => {
    const signature = computeWebhookSignature(body, SECRET);
    expect(signature).toHaveLength(128);
    expect(p.verifyWebhookSignature(body, signature)).toBe(true);
    expect(p.verifyWebhookSignature(Buffer.from(body, 'utf8'), signature.toUpperCase())).toBe(true);
  });

  it('rejects missing, wrong, length-mismatched and re-serialised bodies', () => {
    const signature = computeWebhookSignature(body, SECRET);
    expect(p.verifyWebhookSignature(body, null)).toBe(false);
    expect(p.verifyWebhookSignature(body, '')).toBe(false);
    expect(p.verifyWebhookSignature(body, signature.slice(0, 127))).toBe(false);
    expect(p.verifyWebhookSignature(body, `${signature}00`)).toBe(false);
    expect(p.verifyWebhookSignature(body, computeWebhookSignature(body, 'sk_test_other'))).toBe(
      false,
    );
    expect(p.verifyWebhookSignature(JSON.stringify(JSON.parse(body)), signature)).toBe(false);
    expect(p.verifyWebhookSignature(`${body} `, signature)).toBe(false);
  });

  it('parses an authenticated event', () => {
    const event = p.parseWebhookEvent(body);
    expect(event.provider).toBe('paystack');
    expect(event.eventType).toBe('charge.success');
    expect(event.reference).toBe('qTPrJoy9Bx');
    expect(() => p.parseWebhookEvent('{not json')).toThrow(ProviderError);
    expect(() => p.parseWebhookEvent('{"event":"x"}')).toThrow(/envelope/);
  });
});
