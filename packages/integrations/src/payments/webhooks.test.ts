import { describe, expect, it } from 'vitest';
import { parseProviderWebhookBody } from './events';
import { fixtureText } from './fixtures.test-helpers';
import type { ParsedProviderEvent } from './types';
import { deriveDedupeKey, planWebhookActions, type ExistingRecords } from './webhook-processing';

const parse = (name: string): ParsedProviderEvent =>
  parseProviderWebhookBody(fixtureText(name), 'paystack');

describe('parseProviderWebhookBody (official fixtures)', () => {
  it('parses charge.success', () => {
    const event = parse('charge-success.json');
    expect(event.eventType).toBe('charge.success');
    expect(event.reference).toBe('qTPrJoy9Bx');
    expect(event.amountKobo).toBe(10000n);
    expect(event.currency).toBe('NGN');
    expect(event.environment).toBe('live');
    expect(event.status).toBe('success');
    expect(event.providerObjectId).toBe('302961');
    expect(event.providerEventId).toBe('charge.success:302961:success');
    expect(event.occurredAt).toBe('2016-09-30T21:10:19.000Z');
    expect(event.refundReference).toBeNull();
    // sanitized payload: no card token, IP or log
    const auth = event.payload.authorization as Record<string, unknown>;
    expect(auth.authorization_code).toBeUndefined();
    expect(auth.last4).toBe('8877');
    expect(event.payload.ip_address).toBeUndefined();
    expect(event.payload.log).toBeUndefined();
  });

  it('parses refund events including string amounts and transaction_reference', () => {
    const pending = parse('refund-pending.json');
    expect(pending.eventType).toBe('refund.pending');
    expect(pending.reference).toBe('tvunjbbd_412829_4b18075d_c7had');
    expect(pending.amountKobo).toBe(10000n);
    expect(pending.refundReference).toBeNull();
    expect(pending.providerRefundId).toBeNull();
    expect(pending.providerEventId).toMatch(/^refund\.pending:h:[0-9a-f]{32}$/);

    const processed = parse('refund-processed.json');
    expect(processed.status).toBe('processed');
    expect(processed.amountKobo).toBe(5000n);
    expect(processed.refundReference).toBe('132013318360');

    const failed = parse('refund-failed.json');
    expect(failed.amountKobo).toBe(20000n);
    expect(failed.refundReference).toBe('TRF_9vgfawjnoz58uxy');

    const attention = parse('refund-needs-attention.json');
    expect(attention.status).toBe('needs-attention');
    expect(attention.providerRefundId).toBe('123456');
    expect(attention.providerEventId).toBe('refund.needs-attention:123456:needs-attention');
  });

  it('parses a dispute and a transfer', () => {
    const dispute = parse('dispute-create.json');
    expect(dispute.eventType).toBe('charge.dispute.create');
    expect(dispute.reference).toBe('qTPrJoy9Bx');
    expect(dispute.amountKobo).toBe(10000n);
    expect(dispute.providerObjectId).toBe('3867');
    expect(dispute.payload.bin).toBeUndefined();
    expect(dispute.payload.dueAt).toBe('2016-10-02T21:10:19.000Z');

    const transfer = parse('transfer-success.json');
    expect(transfer.eventType).toBe('transfer.success');
    expect(transfer.environment).toBe('test');
    expect(transfer.amountKobo).toBe(100000n);
    const recipient = transfer.payload.recipient as Record<string, unknown>;
    const details = recipient.details as Record<string, unknown>;
    expect(details.account_number).toBeUndefined();
  });
});

describe('deriveDedupeKey', () => {
  it('is stable across replays and different across states, amounts and environments', () => {
    const a = deriveDedupeKey(parse('charge-success.json'));
    const b = deriveDedupeKey(parse('charge-success.json'));
    expect(a).toBe(b);
    expect(a).toBe('paystack:live:charge.success:302961:success');

    const pendingText = fixtureText('refund-pending.json');
    const pending = deriveDedupeKey(parseProviderWebhookBody(pendingText, 'paystack'));
    const replayed = deriveDedupeKey(parseProviderWebhookBody(pendingText, 'paystack'));
    expect(pending).toBe(replayed);
    const processedLater = deriveDedupeKey(
      parseProviderWebhookBody(
        pendingText.replace('"refund.pending"', '"refund.processed"').replace('"pending"', '"processed"'),
        'paystack',
      ),
    );
    expect(processedLater).not.toBe(pending);
    const otherAmount = deriveDedupeKey(
      parseProviderWebhookBody(pendingText.replace('"10000"', '"20000"'), 'paystack'),
    );
    expect(otherAmount).not.toBe(pending);
    const testMode = deriveDedupeKey(
      parseProviderWebhookBody(pendingText.replace('"live"', '"test"'), 'paystack'),
    );
    expect(testMode).not.toBe(pending);
    expect(deriveDedupeKey(parseProviderWebhookBody(pendingText, 'dev'))).not.toBe(pending);
  });
});

describe('planWebhookActions', () => {
  const chargeSuccess = parse('charge-success.json');
  const none: ExistingRecords = { attemptStatus: null, alreadyAllocated: false };

  it('never settles directly: charge.success asks for a server verify', () => {
    expect(planWebhookActions(chargeSuccess, { attemptStatus: 'pending', alreadyAllocated: false })).toEqual([
      { kind: 'verify_and_settle', reference: 'qTPrJoy9Bx' },
    ]);
    expect(
      planWebhookActions(chargeSuccess, { attemptStatus: 'initialized', alreadyAllocated: false })[0]!.kind,
    ).toBe('verify_and_settle');
  });

  it('ignores replays for already-allocated or successful attempts', () => {
    expect(planWebhookActions(chargeSuccess, { attemptStatus: 'pending', alreadyAllocated: true })[0]!.kind).toBe('ignore');
    expect(planWebhookActions(chargeSuccess, { attemptStatus: 'successful', alreadyAllocated: true })[0]!.kind).toBe('ignore');
    expect(planWebhookActions(chargeSuccess, { attemptStatus: 'successful', alreadyAllocated: false })[0]!.kind).toBe('ignore');
  });

  it('flags unknown references and status conflicts for reconciliation', () => {
    expect(planWebhookActions(chargeSuccess, none)[0]!.kind).toBe('flag_for_reconciliation');
    expect(planWebhookActions(chargeSuccess, { attemptStatus: 'abandoned', alreadyAllocated: false })[0]!.kind).toBe(
      'flag_for_reconciliation',
    );
    const noReference = { ...chargeSuccess, reference: null };
    expect(planWebhookActions(noReference, none)[0]!.kind).toBe('flag_for_reconciliation');
  });

  it('applies refund states in order and ignores stale or replayed refund events', () => {
    const processed = parse('refund-processed.json');
    const pending = parse('refund-pending.json');
    const failed = parse('refund-failed.json');

    const settle = planWebhookActions(processed, { ...none, refundStatus: 'pending' });
    expect(settle).toEqual([
      expect.objectContaining({ kind: 'update_refund', providerStatus: 'processed', targetStatus: 'settled', needsAttention: false }),
    ]);
    expect(planWebhookActions(processed, { ...none, refundStatus: 'submitted' })[0]).toMatchObject({
      kind: 'update_refund',
      targetStatus: 'settled',
    });
    expect(planWebhookActions(pending, { ...none, refundStatus: 'submitted' })[0]).toMatchObject({
      kind: 'update_refund',
      targetStatus: 'pending',
    });
    // reordered: pending arrives after processed
    expect(planWebhookActions(pending, { ...none, refundStatus: 'settled' })).toEqual([
      { kind: 'ignore', reason: 'stale refund.pending: refund already settled' },
    ]);
    // replay of the current state
    expect(planWebhookActions(pending, { ...none, refundStatus: 'pending' })[0]!.kind).toBe('ignore');
    // provider says processed after we recorded failed: conflict, human review
    expect(planWebhookActions(processed, { ...none, refundStatus: 'failed' })[0]!.kind).toBe('flag_for_reconciliation');
    // provider refund we never submitted
    expect(planWebhookActions(pending, { ...none, refundStatus: 'approved' })[0]!.kind).toBe('flag_for_reconciliation');
    expect(planWebhookActions(pending, { ...none, refundStatus: null })[0]!.kind).toBe('flag_for_reconciliation');
    expect(planWebhookActions(failed, { ...none, refundStatus: 'pending' })[0]).toMatchObject({
      kind: 'update_refund',
      targetStatus: 'failed',
    });
  });

  it('keeps needs-attention refunds pending and flags them', () => {
    const attention = parse('refund-needs-attention.json');
    const actions = planWebhookActions(attention, { ...none, refundStatus: 'submitted' });
    expect(actions.map((a) => a.kind)).toEqual(['update_refund', 'flag_for_reconciliation']);
    expect(actions[0]).toMatchObject({ targetStatus: 'pending', needsAttention: true });
    const already = planWebhookActions(attention, { ...none, refundStatus: 'pending' });
    expect(already.map((a) => a.kind)).toEqual(['flag_for_reconciliation']);
  });

  it('opens a chargeback once and routes reminders and resolutions', () => {
    const dispute = parse('dispute-create.json');
    const opened = planWebhookActions(dispute, { attemptStatus: 'successful', alreadyAllocated: true });
    expect(opened).toEqual([
      {
        kind: 'open_chargeback',
        reference: 'qTPrJoy9Bx',
        amountKobo: 10000n,
        currency: 'NGN',
        providerDisputeId: '3867',
        evidenceDueAt: '2016-10-02T21:10:19.000Z',
      },
    ]);
    expect(
      planWebhookActions(dispute, { attemptStatus: 'successful', alreadyAllocated: true, chargebackStatus: 'opened' })[0]!.kind,
    ).toBe('ignore');
    expect(planWebhookActions(dispute, none)[0]!.kind).toBe('flag_for_reconciliation');

    const remind = { ...dispute, eventType: 'charge.dispute.remind' };
    expect(planWebhookActions(remind, { attemptStatus: 'successful', alreadyAllocated: true, chargebackStatus: 'opened' })[0]!.kind).toBe(
      'chargeback_reminder',
    );
    const resolve = {
      ...dispute,
      eventType: 'charge.dispute.resolve',
      payload: { ...dispute.payload, resolution: 'merchant-accepted' },
    };
    expect(
      planWebhookActions(resolve, { attemptStatus: 'successful', alreadyAllocated: true, chargebackStatus: 'evidence_submitted' }),
    ).toEqual([{ kind: 'resolve_chargeback', reference: 'qTPrJoy9Bx', providerDisputeId: '3867', resolution: 'lost' }]);
    expect(
      planWebhookActions(resolve, { attemptStatus: 'successful', alreadyAllocated: true, chargebackStatus: 'won' })[0]!.kind,
    ).toBe('ignore');
    const unknownResolution = { ...resolve, payload: { ...dispute.payload, resolution: 'something-new' } };
    expect(
      planWebhookActions(unknownResolution, { attemptStatus: 'successful', alreadyAllocated: true, chargebackStatus: 'opened' })[0],
    ).toMatchObject({ resolution: 'unknown' });
  });

  it('records but does not act on transfers and unknown events', () => {
    expect(planWebhookActions(parse('transfer-success.json'), none)[0]!.kind).toBe('ignore');
    expect(planWebhookActions({ ...chargeSuccess, eventType: 'subscription.create' }, none)[0]!.kind).toBe('ignore');
    expect(planWebhookActions({ ...chargeSuccess, eventType: 'bank.transfer.rejected' }, none)[0]!.kind).toBe(
      'flag_for_reconciliation',
    );
  });
});
