import { describe, expect, it } from 'vitest';
import { availableTransitions, evaluateTransition } from './machine';
import {
  bidMachine,
  changeOrderMachine,
  engagementMachine,
  invoiceMachine,
  paymentAttemptMachine,
  refundMachine,
  reportMachine,
  tenderMachine,
} from './machines';

describe('engagement machine', () => {
  it('follows the shared pipeline', () => {
    expect(
      evaluateTransition(engagementMachine, { from: 'inquiry', to: 'triage', actor: 'staff' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, { from: 'triage', to: 'quoted', actor: 'staff' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, { from: 'quoted', to: 'accepted', actor: 'customer' })
        .ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, {
        from: 'accepted',
        to: 'awaiting_payment',
        actor: 'system',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, {
        from: 'awaiting_payment',
        to: 'in_progress',
        actor: 'system',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, {
        from: 'in_progress',
        to: 'in_review',
        actor: 'staff',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, { from: 'in_review', to: 'delivered', actor: 'staff' })
        .ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, {
        from: 'delivered',
        to: 'completed',
        actor: 'customer',
      }).ok,
    ).toBe(true);
  });

  it('blocks customers from staff-only steps and skipping states', () => {
    expect(
      evaluateTransition(engagementMachine, { from: 'inquiry', to: 'triage', actor: 'customer' }),
    ).toMatchObject({ code: 'actor_not_allowed' });
    expect(
      evaluateTransition(engagementMachine, { from: 'inquiry', to: 'in_progress', actor: 'staff' }),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(
      evaluateTransition(engagementMachine, { from: 'quoted', to: 'accepted', actor: 'staff' }),
    ).toMatchObject({ code: 'actor_not_allowed' });
  });

  it('requires reasons for rejection, pausing and cancellation and freezes terminal states', () => {
    expect(
      evaluateTransition(engagementMachine, { from: 'triage', to: 'rejected', actor: 'staff' }),
    ).toMatchObject({ code: 'reason_required' });
    expect(
      evaluateTransition(engagementMachine, {
        from: 'in_progress',
        to: 'paused',
        actor: 'customer',
        reason: 'travelling',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(engagementMachine, {
        from: 'in_progress',
        to: 'cancelled',
        actor: 'customer',
        reason: ' ',
      }),
    ).toMatchObject({ code: 'reason_required' });
    expect(
      evaluateTransition(engagementMachine, {
        from: 'completed',
        to: 'in_progress',
        actor: 'staff',
      }),
    ).toMatchObject({ code: 'terminal_state' });
  });

  it('lists what an actor can do next', () => {
    const next = availableTransitions(engagementMachine, 'quoted', 'customer').map((t) => t.to);
    expect(next.sort()).toEqual(['accepted', 'cancelled', 'rejected']);
  });
});

describe('finance machines', () => {
  it('invoice lifecycle and void guard', () => {
    expect(
      evaluateTransition(invoiceMachine, { from: 'draft', to: 'issued', actor: 'staff' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(invoiceMachine, { from: 'issued', to: 'partially_paid', actor: 'system' })
        .ok,
    ).toBe(true);
    expect(
      evaluateTransition(invoiceMachine, { from: 'partially_paid', to: 'paid', actor: 'system' })
        .ok,
    ).toBe(true);
    expect(
      evaluateTransition(invoiceMachine, { from: 'paid', to: 'void', actor: 'staff', reason: 'x' }),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(
      evaluateTransition(invoiceMachine, { from: 'issued', to: 'void', actor: 'staff' }),
    ).toMatchObject({ code: 'reason_required' });
  });

  it('payment attempts settle only via system verification and can be reversed', () => {
    expect(
      evaluateTransition(paymentAttemptMachine, {
        from: 'pending',
        to: 'successful',
        actor: 'customer',
      }),
    ).toMatchObject({ code: 'actor_not_allowed' });
    expect(
      evaluateTransition(paymentAttemptMachine, {
        from: 'uncertain',
        to: 'successful',
        actor: 'system',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(paymentAttemptMachine, {
        from: 'successful',
        to: 'reversed',
        actor: 'system',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(paymentAttemptMachine, {
        from: 'failed',
        to: 'successful',
        actor: 'system',
      }),
    ).toMatchObject({ code: 'terminal_state' });
  });

  it('refunds are not settled from submission alone', () => {
    expect(
      evaluateTransition(refundMachine, { from: 'approved', to: 'settled', actor: 'system' }),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(
      evaluateTransition(refundMachine, { from: 'submitted', to: 'settled', actor: 'system' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(refundMachine, { from: 'requested', to: 'approved', actor: 'customer' }),
    ).toMatchObject({ code: 'actor_not_allowed' });
  });
});

describe('commercial and project machines', () => {
  it('tenders close by server time and bids cannot change after evaluation', () => {
    expect(
      evaluateTransition(tenderMachine, { from: 'published', to: 'closed', actor: 'staff' }),
    ).toMatchObject({ code: 'actor_not_allowed' });
    expect(
      evaluateTransition(tenderMachine, { from: 'published', to: 'closed', actor: 'system' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(bidMachine, { from: 'submitted', to: 'submitted', actor: 'partner' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(bidMachine, { from: 'evaluated', to: 'submitted', actor: 'partner' }),
    ).toMatchObject({ code: 'invalid_transition' });
  });

  it('change orders need staff then customer approval', () => {
    expect(
      evaluateTransition(changeOrderMachine, {
        from: 'staff_review',
        to: 'approved',
        actor: 'staff',
      }),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(
      evaluateTransition(changeOrderMachine, {
        from: 'staff_review',
        to: 'customer_review',
        actor: 'staff',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(changeOrderMachine, {
        from: 'customer_review',
        to: 'approved',
        actor: 'customer',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(changeOrderMachine, {
        from: 'customer_review',
        to: 'approved',
        actor: 'staff',
      }),
    ).toMatchObject({ code: 'actor_not_allowed' });
  });

  it('reports are released only after approval', () => {
    expect(
      evaluateTransition(reportMachine, { from: 'draft', to: 'released', actor: 'staff' }),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(
      evaluateTransition(reportMachine, { from: 'in_review', to: 'approved', actor: 'staff' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(reportMachine, { from: 'approved', to: 'released', actor: 'partner' }),
    ).toMatchObject({ code: 'actor_not_allowed' });
  });
});
