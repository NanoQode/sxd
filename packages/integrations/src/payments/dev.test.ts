import { afterEach, describe, expect, it } from 'vitest';
import { DEV_ADAPTER_LABEL, DevPaymentProvider } from './dev';
import { ProviderError } from './errors';
import { createPaymentProvider } from './factory';
import { matchVerification } from './matching';
import { PaystackPaymentProvider } from './paystack';
import { deriveDedupeKey, planWebhookActions } from './webhook-processing';

const originalAppEnv = process.env.APP_ENV;

afterEach(() => {
  if (originalAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = originalAppEnv;
});

const init = {
  reference: 'sxd-inv-7-a1',
  amountKobo: 250_000n,
  currency: 'NGN',
  email: 'customer@example.com',
  callbackUrl: 'http://localhost:3000/pay/callback',
};

describe('DevPaymentProvider', () => {
  it('refuses live and production', () => {
    expect(() => new DevPaymentProvider({ appUrl: 'http://localhost:3000', environment: 'live' })).toThrow(/live/);
    expect(() => new DevPaymentProvider({ appUrl: 'http://localhost:3000', appEnv: 'production' })).toThrow(/production/);
    process.env.APP_ENV = 'production';
    expect(() => new DevPaymentProvider({ appUrl: 'http://localhost:3000' })).toThrow(/production/);
    process.env.APP_ENV = 'development';
    expect(new DevPaymentProvider({ appUrl: 'http://localhost:3000' }).id).toBe('dev');
  });

  it('initializes to the local checkout page and stays pending until simulated', async () => {
    const dev = new DevPaymentProvider({ appUrl: 'http://localhost:3000', appEnv: 'development' });
    const result = await dev.initialize(init);
    expect(result.authorizationUrl).toBe('http://localhost:3000/dev/paystack-checkout?reference=sxd-inv-7-a1');
    expect(result.accessCode).toMatch(/^dev_/);
    expect(result.providerReference).toBe(init.reference);
    await expect(dev.initialize(init)).rejects.toMatchObject({ code: 'invalid_request', providerCode: 'duplicate_reference' });

    const pending = await dev.verify(init.reference);
    expect(pending.providerStatus).toBe('pending');
    expect(matchVerification({ attempt: { ...init, status: 'pending' }, verification: pending, ageSeconds: 5 }).decision).toBe(
      'keep_pending',
    );

    dev.simulate(init.reference, 'success');
    const success = await dev.verify(init.reference);
    expect(success.providerStatus).toBe('success');
    expect(success.amountKobo).toBe(250_000n);
    expect(success.feesKobo).toBe(3_750n);
    expect(matchVerification({ attempt: { ...init, status: 'pending' }, verification: success }).decision).toBe('settle');

    dev.simulate(init.reference, 'success', { amountKobo: 999_999n });
    const tampered = await dev.verify(init.reference);
    expect(matchVerification({ attempt: { ...init, status: 'pending' }, verification: tampered }).decision).toBe('mismatch');

    expect((await dev.verify('never-initialized')).providerStatus).toBe('unknown');
    expect(() => dev.simulate('never-initialized', 'success')).toThrow(ProviderError);
  });

  it('runs the refund lifecycle without settling on submission', async () => {
    const dev = new DevPaymentProvider({ appUrl: 'http://localhost:3000', appEnv: 'test' });
    await dev.initialize(init);
    await expect(
      dev.createRefund({ reference: init.reference, reason: 'x', idempotencyKey: 'r1' }),
    ).rejects.toThrow(/not successful/);
    dev.simulate(init.reference, 'success');
    const refund = await dev.createRefund({ reference: init.reference, amountKobo: 100_000n, reason: 'partial', idempotencyKey: 'r1' });
    expect(refund.status).toBe('pending');
    const again = await dev.createRefund({ reference: init.reference, amountKobo: 100_000n, reason: 'partial', idempotencyKey: 'r1' });
    expect(again.providerRefundId).toBe(refund.providerRefundId);
    await expect(
      dev.createRefund({ reference: init.reference, amountKobo: 900_000n, reason: 'too much', idempotencyKey: 'r2' }),
    ).rejects.toThrow(/cannot be more/);
    dev.simulateRefund(refund.providerRefundId, 'processed');
    expect((await dev.getRefund(refund.providerRefundId)).status).toBe('processed');

    const delivery = dev.buildWebhookEvent('refund.processed', init.reference, { providerRefundId: refund.providerRefundId });
    const event = dev.parseWebhookEvent(delivery.rawBody);
    expect(dev.verifyWebhookSignature(delivery.rawBody, delivery.signature)).toBe(true);
    expect(event.eventType).toBe('refund.processed');
    expect(event.reference).toBe(init.reference);
    expect(event.providerRefundId).toBe(refund.providerRefundId);
    expect(planWebhookActions(event, { attemptStatus: 'successful', alreadyAllocated: true, refundStatus: 'pending' })[0]).toMatchObject({
      kind: 'update_refund',
      targetStatus: 'settled',
    });
  });

  it('signs simulated webhooks that the same adapter verifies and dedupes', async () => {
    const dev = new DevPaymentProvider({ appUrl: 'http://localhost:3000', appEnv: 'development' });
    await dev.initialize(init);
    dev.simulate(init.reference, 'success');
    const delivery = dev.buildWebhookEvent('charge.success', init.reference);
    expect(delivery.headers['x-paystack-signature']).toBe(delivery.signature);
    expect(dev.verifyWebhookSignature(delivery.rawBody, delivery.signature)).toBe(true);
    expect(dev.verifyWebhookSignature(`${delivery.rawBody}x`, delivery.signature)).toBe(false);
    const event = dev.parseWebhookEvent(delivery.rawBody);
    expect(event.provider).toBe('dev');
    expect(event.environment).toBe('test');
    expect(event.reference).toBe(init.reference);
    expect(deriveDedupeKey(event)).toBe(deriveDedupeKey(dev.parseWebhookEvent(dev.buildWebhookEvent('charge.success', init.reference).rawBody)));
    expect(planWebhookActions(event, { attemptStatus: 'pending', alreadyAllocated: false })).toEqual([
      { kind: 'verify_and_settle', reference: init.reference },
    ]);
    const dispute = dev.parseWebhookEvent(dev.buildWebhookEvent('charge.dispute.create', init.reference).rawBody);
    expect(dispute.amountKobo).toBe(250_000n);
    expect(planWebhookActions(dispute, { attemptStatus: 'successful', alreadyAllocated: true })[0]!.kind).toBe('open_chargeback');
  });

  it('reports itself honestly on connection test', async () => {
    const dev = new DevPaymentProvider({ appUrl: 'http://localhost:3000', appEnv: 'development' });
    expect(await dev.testConnection()).toEqual({ ok: true, message: DEV_ADAPTER_LABEL, environmentDetected: 'test' });
    expect(DEV_ADAPTER_LABEL).toBe('development adapter, not a real gateway');
  });
});

describe('createPaymentProvider', () => {
  it('refuses the dev adapter in production and builds it elsewhere', () => {
    expect(() =>
      createPaymentProvider({ provider: 'dev', environment: 'test', appUrl: 'http://localhost:3000', appEnv: 'production' }),
    ).toThrow(/refused when APP_ENV=production/);
    process.env.APP_ENV = 'production';
    expect(() => createPaymentProvider({ provider: 'dev', environment: 'test', appUrl: 'http://localhost:3000' })).toThrow(
      /production/,
    );
    const dev = createPaymentProvider({ provider: 'dev', environment: 'test', appUrl: 'http://localhost:3000', appEnv: 'development' });
    expect(dev).toBeInstanceOf(DevPaymentProvider);
  });

  it('requires a matching Paystack secret key', () => {
    expect(() =>
      createPaymentProvider({ provider: 'paystack', environment: 'test', appUrl: 'https://app.example.com' }),
    ).toThrow(/not configured/);
    expect(() =>
      createPaymentProvider({
        provider: 'paystack',
        environment: 'live',
        secretKey: 'sk_test_abc',
        appUrl: 'https://app.example.com',
      }),
    ).toThrow(/test key but the integration is set to live/);
    const paystack = createPaymentProvider({
      provider: 'paystack',
      environment: 'test',
      secretKey: 'sk_test_abc',
      publicKey: 'pk_test_abc',
      appUrl: 'https://app.example.com',
      appEnv: 'production',
    });
    expect(paystack).toBeInstanceOf(PaystackPaymentProvider);
    expect(paystack.environment).toBe('test');
  });
});
