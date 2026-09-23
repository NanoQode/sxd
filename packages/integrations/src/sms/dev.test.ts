import { describe, expect, it } from 'vitest';
import { DevSmsProvider } from './dev';
import { createSmsProvider } from './factory';
import { classifyInboundKeyword } from './policy';

const send = (provider: DevSmsProvider, to: string, key: string) =>
  provider.send({
    to,
    from: 'SimplexD',
    body: 'SimplexD test message from test at now.',
    category: 'transactional',
    idempotencyKey: key,
  });

describe('development SMS adapter', () => {
  it('refuses production', () => {
    expect(() => new DevSmsProvider({ nodeEnv: 'production' })).toThrow(/production/);
    expect(() => createSmsProvider({ adapter: 'dev', nodeEnv: 'production' })).toThrow(
      /production/,
    );
    expect(createSmsProvider({ adapter: 'dev', nodeEnv: 'development' }).id).toBe('dev');
  });

  it('records messages with deterministic ids and dedupes on the idempotency key', async () => {
    const provider = new DevSmsProvider({ nodeEnv: 'test' });
    const first = await send(provider, '08031234567', 'booking:42');
    const second = await send(provider, '08031234567', 'booking:42');
    expect(first.accepted).toBe(true);
    expect(first.providerMessageId).toMatch(/^dev-sms-[0-9a-f]{16}$/);
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]).toMatchObject({
      to: '+2348031234567',
      channel: 'dnd',
      segments: 1,
      deliveryState: 'delivered',
    });
    const status = await provider.getMessageStatus(first.providerMessageId!);
    expect(status).toMatchObject({ found: true, deliveryState: 'delivered' });
  });

  it('simulates signed delivery receipts that parse like Termii webhooks', async () => {
    const provider = new DevSmsProvider({ nodeEnv: 'test' });
    const result = await send(provider, '+2348031234567', 'receipt:1');
    const receipt = provider.simulateDeliveryReceipt(result.providerMessageId!)!;
    const event = provider.parseDeliveryWebhook(receipt.rawBody, receipt.headers);
    expect(event).toMatchObject({
      type: 'outbound',
      providerMessageId: result.providerMessageId,
      recipient: '+2348031234567',
      deliveryState: 'delivered',
      signature: 'valid',
    });
    const tampered = provider.parseDeliveryWebhook(
      receipt.rawBody.replace('DELIVERED', 'Failed'),
      receipt.headers,
    );
    expect(tampered.signature).toBe('invalid');
    expect(provider.simulateDeliveryReceipt('missing')).toBeNull();
  });

  it('simulates provider failures by recipient suffix', async () => {
    const provider = new DevSmsProvider({ nodeEnv: 'test' });
    const failed = await send(provider, '+2348030001111', 'f:1');
    expect(failed.accepted).toBe(true);
    expect(await provider.getMessageStatus(failed.providerMessageId!)).toMatchObject({
      deliveryState: 'failed',
    });
    const rejected = await send(provider, '+2348030000000', 'f:2');
    expect(rejected).toMatchObject({ accepted: false, retryable: false });
  });

  it('simulates inbound STOP replies for opt-out handling', () => {
    const provider = new DevSmsProvider({ nodeEnv: 'test' });
    const inbound = provider.simulateInbound('+2348031234567', 'STOP')!;
    const event = provider.parseDeliveryWebhook(inbound.rawBody, inbound.headers);
    expect(event).toMatchObject({
      type: 'inbound',
      sender: '+2348031234567',
      inboundText: 'STOP',
      signature: 'valid',
    });
    expect(classifyInboundKeyword(event.inboundText)).toBe('opt_out');
  });
});
