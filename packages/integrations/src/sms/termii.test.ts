import { describe, expect, it } from 'vitest';
import {
  mapTermiiStatus,
  parseTermiiJson,
  parseTermiiWebhookPayload,
  signTermiiPayload,
  TermiiSmsProvider,
  verifyTermiiSignature,
  type TermiiConfigInput,
} from './termii';

interface Call {
  url: string;
  init: RequestInit;
}

type Responder = (call: Call) => { status: number; body: unknown };

function fakeFetch(responder: Responder): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const result = responder(call);
    return new Response(
      typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
      { status: result.status, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const API_KEY = 'sk-termii-test-key-1234';
const WEBHOOK_SECRET = 'whsec-development-secret';

const config: TermiiConfigInput = {
  apiKey: API_KEY,
  senderId: 'SimplexD',
  environment: 'test',
  webhookSecret: WEBHOOK_SECRET,
};

const okDestination = { destinationCheck: async () => ({ ok: true }) };

const SEND_OK =
  '{"code":"ok","message_id":9122821270554876574,"message":"Successfully Sent","balance":9,"user":"Peter Mcleish"}';

// Research fixtures (docs/providers/research/paystack-termii-research-2026-09-23.md B.9)
const OUTBOUND_FIXTURE =
  '{"type":"outbound","message_id":"902022080211300900000078460","message_id_str":"902022080211300900000078460","receiver":"2348147386362","sender":"MAlert","message":"Hi there, testing Gotrade","sent_at":"2022-08-02 11:30:11","cost":"3.9","pages":"1","command":"deliver","status":"DELIVERED | Message delivered to handset","channel":"DND","msgtype":5,"origid":"902022080211300900000078460","messagestate":"Delivered","notify_id":"902022080211300900000078460"}';
const INBOUND_FIXTURE =
  '{"type":"inbound","id":"8248611476370959318","message_id":"3905204342778053556","receiver":"12022214836","sender":"2347069549231","message":"Great ","received_at":"2020-12-16T10:51:03.000000Z","cost":null,"command":"Received","status":"Received","channel":null}';
const DEVICE_FIXTURE =
  '{"type":"device_status","status":"disconnected","device_id":"e0c5a9b-0136-4751-9be9-a3c9zzTc0a19","name":"TermiiWh"}';

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('Termii adapter: sending', () => {
  it('posts api_key in the body, digits-only recipient and the DND channel for transactional', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: SEND_OK }));
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const result = await provider.send({
      to: '0803 123 4567',
      from: 'SimplexD',
      body: 'SimplexD: your consultation is confirmed.',
      category: 'transactional',
      idempotencyKey: 'booking:1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://v3.api.termii.com/api/sms/send');
    expect(calls[0]!.init.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({
      api_key: API_KEY,
      to: '2348031234567',
      from: 'SimplexD',
      sms: 'SimplexD: your consultation is confirmed.',
      type: 'plain',
      channel: 'dnd',
    });
    expect(result).toEqual({
      accepted: true,
      providerMessageId: '9122821270554876574',
      providerStatus: 'Successfully Sent',
      balance: 9,
      retryable: false,
    });
  });

  it('uses the generic channel for marketing and honours an explicit channel', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: SEND_OK }));
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    await provider.send({
      to: '+2348031234567',
      from: 'SimplexD',
      body: 'Offer',
      category: 'marketing',
      idempotencyKey: 'camp:1',
    });
    await provider.send({
      to: '+2348031234567',
      from: 'SimplexD',
      body: 'Code',
      category: 'security',
      channel: 'whatsapp',
      idempotencyKey: 'otp:1',
    });
    expect(bodyOf(calls[0]!).channel).toBe('generic');
    expect(bodyOf(calls[1]!).channel).toBe('whatsapp');
  });

  it('rejects invalid recipients without calling the provider', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: SEND_OK }));
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const result = await provider.send({
      to: '12345',
      from: 'SimplexD',
      body: 'x',
      category: 'transactional',
      idempotencyKey: 'bad:1',
    });
    expect(result.accepted).toBe(false);
    expect(result.errorSanitized).toMatch(/invalid recipient/);
    expect(calls).toHaveLength(0);
  });

  it('sanitises provider errors so the API key never leaks, and flags retryable statuses', async () => {
    const { fetchImpl } = fakeFetch(({ url }) => {
      if (url.includes('/bulk')) return { status: 500, body: { message: 'boom' } };
      return { status: 401, body: { message: `Unauthorized key ${API_KEY} api_key=${API_KEY}` } };
    });
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const unauthorized = await provider.send({
      to: '+2348031234567',
      from: 'SimplexD',
      body: 'x',
      category: 'transactional',
      idempotencyKey: 'k:1',
    });
    expect(unauthorized.accepted).toBe(false);
    expect(unauthorized.retryable).toBe(false);
    expect(unauthorized.errorSanitized).not.toContain(API_KEY);
    expect(unauthorized.errorSanitized).toContain('[redacted]');
    expect(unauthorized.errorSanitized).toMatch(/HTTP 401/);

    const serverError = await provider.sendBulk({
      to: ['+2348031234567'],
      from: 'SimplexD',
      body: 'x',
      category: 'transactional',
      idempotencyKey: 'k:2',
    });
    expect(serverError[0]).toMatchObject({ accepted: false, retryable: true });
  });

  it('treats network failures and timeouts as retryable', async () => {
    const failing = (async () => {
      throw new Error(`ECONNRESET while sending ${API_KEY}`);
    }) as unknown as typeof fetch;
    const provider = new TermiiSmsProvider(config, { fetch: failing, ...okDestination });
    const result = await provider.send({
      to: '+2348031234567',
      from: 'SimplexD',
      body: 'x',
      category: 'transactional',
      idempotencyKey: 'n:1',
    });
    expect(result).toMatchObject({ accepted: false, retryable: true });
    expect(result.errorSanitized).not.toContain(API_KEY);

    const hanging = ((_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const slow = new TermiiSmsProvider(
      { ...config, timeoutMs: 1000 },
      { fetch: hanging, ...okDestination },
    );
    const timedOut = await slow.getBalance();
    expect(timedOut.ok).toBe(false);
    expect(timedOut.errorSanitized).toMatch(/timed out/);
  });

  it('chunks bulk sends at 100 recipients and reports duplicates and invalid entries', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: SEND_OK }));
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const recipients = Array.from({ length: 150 }, (_, i) => `+23480${String(30000000 + i)}`);
    const results = await provider.sendBulk({
      to: recipients,
      from: 'SimplexD',
      body: 'Bulk',
      category: 'marketing',
      idempotencyKey: 'bulk:1',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://v3.api.termii.com/api/sms/send/bulk');
    expect((bodyOf(calls[0]!).to as string[]).length).toBe(100);
    expect((bodyOf(calls[1]!).to as string[]).length).toBe(50);
    expect((bodyOf(calls[0]!).to as string[])[0]).toBe('2348030000000');
    expect(results).toHaveLength(150);
    expect(results.every((r) => r.accepted && r.providerMessageId === '9122821270554876574')).toBe(
      true,
    );

    const mixed = await provider.sendBulk({
      to: ['+2348031234567', '08031234567', 'nope'],
      from: 'SimplexD',
      body: 'Bulk',
      category: 'marketing',
      idempotencyKey: 'bulk:2',
    });
    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]!).to as string[]).toEqual(['2348031234567']);
    expect(mixed[0]!.accepted).toBe(true);
    expect(mixed[1]).toMatchObject({ accepted: false, providerStatus: 'duplicate' });
    expect(mixed[2]).toMatchObject({
      accepted: false,
      errorSanitized: expect.stringMatching(/invalid/),
    });
  });
});

describe('Termii adapter: account endpoints', () => {
  it('reads the balance with api_key as a query parameter', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { user: 'SimplexD', balance: 785.57, currency: 'NGN' },
    }));
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    expect(await provider.getBalance()).toEqual({ ok: true, balance: 785.57, currency: 'NGN' });
    expect(calls[0]!.url).toBe(`https://v3.api.termii.com/api/get-balance?api_key=${API_KEY}`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('lists sender IDs, requests new ones with both use_case spellings and tests the connection', async () => {
    const { calls, fetchImpl } = fakeFetch(({ url }) => {
      if (url.includes('/api/get-balance'))
        return { status: 200, body: { balance: 12, currency: 'NGN' } };
      if (url.includes('/api/sender-id/request')) {
        return { status: 200, body: { code: 'ok', message: 'Sender Id request submitted' } };
      }
      if (url.includes('/api/sender-id')) {
        return {
          status: 200,
          body: {
            current_page: 1,
            data: [
              {
                sender_id: 'SimplexD',
                status: 'unblock',
                company: 'SimplexD',
                usecase: 'Alerts',
                country: 'NG',
                created_at: '2026-01-01',
              },
              {
                sender_id: 'Pending1',
                status: 'pending',
                company: null,
                usecase: null,
                country: null,
                created_at: null,
              },
            ],
          },
        };
      }
      return { status: 404, body: { message: 'not found' } };
    });
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const list = await provider.listSenderIds();
    expect(list.ok).toBe(true);
    expect(list.senderIds[0]).toMatchObject({
      senderId: 'SimplexD',
      approval: 'approved',
      useCase: 'Alerts',
    });
    expect(list.senderIds[1]).toMatchObject({ approval: 'pending' });

    const request = await provider.requestSenderId({
      senderId: 'SxdAlert',
      useCase: 'Booking alerts',
      company: 'SimplexD Ltd',
    });
    expect(request).toEqual({ ok: true, message: 'Sender Id request submitted' });
    const requestCall = calls.find((c) => c.url.endsWith('/api/sender-id/request'))!;
    expect(bodyOf(requestCall)).toMatchObject({
      api_key: API_KEY,
      sender_id: 'SxdAlert',
      use_case: 'Booking alerts',
      usecase: 'Booking alerts',
      company: 'SimplexD Ltd',
    });

    const test = await provider.testConnection();
    expect(test.ok).toBe(true);
    expect(test.senderIdApproval).toBe('approved');
    expect(test.message).toMatch(/approved/);
    expect(test.balance).toBe(12);
  });

  it('reports an unregistered sender ID as not connected', async () => {
    const { fetchImpl } = fakeFetch(({ url }) =>
      url.includes('get-balance')
        ? { status: 200, body: { balance: 1 } }
        : { status: 200, body: { data: [] } },
    );
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const test = await provider.testConnection();
    expect(test).toMatchObject({ ok: false, senderIdApproval: 'not_registered' });
  });

  it('polls message status from the history endpoint and maps the status', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            sender: 'SimplexD',
            receiver: '2348031234567',
            message: 'x',
            amount: 3.9,
            status: 'DND Active on Phone Number',
            sms_type: 'generic',
            message_id: '9122821270554876574',
            created_at: '2026-09-23 10:00:00',
          },
        ],
      },
    }));
    const provider = new TermiiSmsProvider(config, { fetch: fetchImpl, ...okDestination });
    const status = await provider.getMessageStatus('9122821270554876574');
    expect(calls[0]!.url).toContain('/api/sms/inbox?api_key=');
    expect(calls[0]!.url).toContain('message_id=9122821270554876574');
    expect(status).toMatchObject({
      found: true,
      deliveryState: 'rejected',
      providerStatus: 'DND Active on Phone Number',
      recipient: '+2348031234567',
      cost: 3.9,
    });
    expect(status.occurredAt?.toISOString()).toBe('2026-09-23T09:00:00.000Z');
  });
});

describe('Termii adapter: configuration and destination policy', () => {
  it('rejects http, credentialed and non-allow-listed base URLs at construction', () => {
    expect(() => new TermiiSmsProvider({ ...config, baseUrl: 'http://v3.api.termii.com' })).toThrow(
      /https/,
    );
    expect(
      () => new TermiiSmsProvider({ ...config, baseUrl: 'https://user:pw@v3.api.termii.com' }),
    ).toThrow(/credentials/);
    expect(() => new TermiiSmsProvider({ ...config, baseUrl: 'https://evil.example.com' })).toThrow(
      /allow-list/,
    );
    expect(
      () => new TermiiSmsProvider({ ...config, baseUrl: 'https://api.ng.termii.com/' }),
    ).not.toThrow();
    expect(() => new TermiiSmsProvider({ ...config, apiKey: 'short' })).toThrow(/apiKey/);
  });

  it('refuses to send when the destination policy rejects the resolved address', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: SEND_OK }));
    const provider = new TermiiSmsProvider(config, {
      fetch: fetchImpl,
      destinationCheck: async () => ({ ok: false, reason: 'resolves to a private address' }),
    });
    const result = await provider.send({
      to: '+2348031234567',
      from: 'SimplexD',
      body: 'x',
      category: 'transactional',
      idempotencyKey: 'd:1',
    });
    expect(result).toMatchObject({ accepted: false, retryable: false });
    expect(result.errorSanitized).toMatch(/destination policy/);
    expect(calls).toHaveLength(0);
  });

  it('describes itself without exposing the key', () => {
    const provider = new TermiiSmsProvider(config, okDestination);
    const description = provider.describe();
    expect(JSON.stringify(description)).not.toContain(API_KEY);
    expect(description).toMatchObject({
      adapter: 'termii',
      baseUrl: 'https://v3.api.termii.com',
      senderId: 'SimplexD',
      webhookSecretConfigured: true,
    });
  });

  it('preserves 64-bit message ids when parsing JSON', () => {
    const parsed = parseTermiiJson(SEND_OK) as { message_id: unknown };
    expect(parsed.message_id).toBe('9122821270554876574');
  });
});

describe('Termii adapter: webhooks', () => {
  it('verifies X-Termii-Signature in constant time (hex or base64) and rejects tampering', () => {
    const signature = signTermiiPayload(OUTBOUND_FIXTURE, WEBHOOK_SECRET);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyTermiiSignature(OUTBOUND_FIXTURE, signature, WEBHOOK_SECRET)).toBe(true);
    expect(verifyTermiiSignature(OUTBOUND_FIXTURE, signature.toUpperCase(), WEBHOOK_SECRET)).toBe(
      true,
    );
    expect(
      verifyTermiiSignature(
        OUTBOUND_FIXTURE,
        Buffer.from(signature, 'hex').toString('base64'),
        WEBHOOK_SECRET,
      ),
    ).toBe(true);
    expect(verifyTermiiSignature(OUTBOUND_FIXTURE, signature, 'another-secret')).toBe(false);
    expect(verifyTermiiSignature(`${OUTBOUND_FIXTURE} `, signature, WEBHOOK_SECRET)).toBe(false);
    expect(verifyTermiiSignature(OUTBOUND_FIXTURE, signature.slice(0, 64), WEBHOOK_SECRET)).toBe(
      false,
    );
    expect(verifyTermiiSignature(OUTBOUND_FIXTURE, undefined, WEBHOOK_SECRET)).toBe(false);
  });

  it('parses an outbound delivery report', () => {
    const provider = new TermiiSmsProvider(config, okDestination);
    const event = provider.parseDeliveryWebhook(OUTBOUND_FIXTURE, {
      'Content-Type': 'application/json',
      'X-Termii-Signature': signTermiiPayload(OUTBOUND_FIXTURE, WEBHOOK_SECRET),
    });
    expect(event).toMatchObject({
      type: 'outbound',
      providerMessageId: '902022080211300900000078460',
      recipient: '+2348147386362',
      deliveryState: 'delivered',
      providerStatus: 'DELIVERED | Message delivered to handset',
      channel: 'DND',
      signature: 'valid',
    });
    // 11:30:11 in Africa/Lagos (UTC+1)
    expect(event.occurredAt?.toISOString()).toBe('2022-08-02T10:30:11.000Z');
  });

  it('parses inbound and device_status events and flags bad or missing signatures', () => {
    const provider = new TermiiSmsProvider(config, okDestination);
    const inbound = provider.parseDeliveryWebhook(INBOUND_FIXTURE, {
      'x-termii-signature': 'deadbeef',
    });
    expect(inbound).toMatchObject({
      type: 'inbound',
      providerMessageId: '3905204342778053556',
      sender: '+2347069549231',
      inboundText: 'Great ',
      deliveryState: 'unknown',
      signature: 'invalid',
    });
    expect(inbound.occurredAt?.toISOString()).toBe('2020-12-16T10:51:03.000Z');

    const device = parseTermiiWebhookPayload(JSON.parse(DEVICE_FIXTURE));
    expect(device).toMatchObject({
      type: 'device_status',
      deliveryState: 'unknown',
      providerStatus: 'disconnected',
      providerMessageId: null,
    });

    expect(parseTermiiWebhookPayload({ hello: 'world' }).type).toBe('unknown');
    expect(parseTermiiWebhookPayload(null).type).toBe('unknown');

    const unchecked = new TermiiSmsProvider({ ...config, webhookSecret: null }, okDestination);
    expect(unchecked.parseDeliveryWebhook(INBOUND_FIXTURE, {}).signature).toBe('unchecked');
  });

  it('maps provider status strings to delivery states', () => {
    expect(mapTermiiStatus('DELIVERED | Message delivered to handset')).toBe('delivered');
    expect(mapTermiiStatus('Delivered')).toBe('delivered');
    expect(mapTermiiStatus('DND Active on Phone Number')).toBe('rejected');
    expect(mapTermiiStatus('Rejected')).toBe('rejected');
    expect(mapTermiiStatus('Message Failed')).toBe('failed');
    expect(mapTermiiStatus('Failed')).toBe('failed');
    expect(mapTermiiStatus('Expired')).toBe('expired');
    expect(mapTermiiStatus('Message Sent')).toBe('sent');
    expect(mapTermiiStatus('Sent')).toBe('sent');
    expect(mapTermiiStatus('Something new')).toBe('unknown');
    expect(mapTermiiStatus(null)).toBe('unknown');
  });
});
