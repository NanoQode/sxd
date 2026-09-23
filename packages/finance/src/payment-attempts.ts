import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  ApiError,
  type Installment,
  type PaymentAttemptCreate,
  type PaymentAttemptDto,
  type PaymentVerifyResult,
} from '@simplexd/contracts';
import { schema, withActor } from '@simplexd/db';
import { invoiceBalance } from '@simplexd/domain/ledger';
import {
  ProviderError,
  matchVerification,
  type MatchOutcome,
  type PaymentChannel,
  type VerifyResult,
} from '@simplexd/integrations/payments';
import {
  assertOrg,
  assertStaffOrOrg,
  elevated,
  requireUserId,
  systemFinanceActor,
  type FinanceActor,
} from './actor';
import { emitEvent, recordAudit } from './audit';
import { iso, kobo } from './money';
import { requireProvider, type FinanceRuntime, type ResolvedProvider } from './runtime';
import {
  recordAttemptOutcome,
  reverseSettledAttempt,
  settleAttempt,
  type PaymentAttemptRow,
} from './settlement';

export const CALLBACK_PATH = '/api/v1/payment-attempts/callback';

export function toPaymentAttemptDto(a: PaymentAttemptRow): PaymentAttemptDto {
  return {
    id: a.id,
    invoiceId: a.invoiceId,
    organizationId: a.organizationId,
    provider: a.provider,
    environment: a.environment,
    reference: a.reference,
    amountKobo: a.amountKobo.toString(),
    currency: a.currency,
    status: a.status,
    channel: a.channel,
    authorizationUrl: a.authorizationUrl,
    accessCode: a.accessCode,
    verifiedAt: iso(a.verifiedAt),
    settledAt: iso(a.settledAt),
    failureReason: a.failureReason,
    feesKobo: kobo(a.feesKobo),
    developmentAdapter: a.provider === 'dev',
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function newAttemptReference(): string {
  return `SXD-${randomBytes(6).toString('hex').toUpperCase()}`;
}

function providerErrorToApi(err: unknown): ApiError {
  if (err instanceof ProviderError) {
    const code =
      err.code === 'auth'
        ? 'provider_not_configured'
        : err.code === 'network' || err.code === 'rate_limited'
          ? 'provider_unavailable'
          : 'payment_verification_failed';
    return new ApiError(code, err.customerMessage, {
      details: { providerCode: err.providerCode, reason: err.code },
      retryable: err.retryable,
    });
  }
  if (err instanceof ApiError) return err;
  return new ApiError(
    'provider_unavailable',
    'the payment service could not be reached; please try again',
  );
}

/**
 * Creates a payment attempt for an issued invoice (customer `org.invoices.pay`)
 * with an immutable reference, amount and currency, then initialises the
 * hosted checkout with the configured provider. The attempt row exists
 * before the provider is called so a lost response can still be verified.
 */
export async function createPaymentAttempt(
  rt: FinanceRuntime,
  fa: FinanceActor,
  invoiceId: string,
  input: PaymentAttemptCreate,
): Promise<PaymentAttemptDto> {
  const userId = requireUserId(fa);
  const environment = rt.defaultEnvironment;
  const resolved = await requireProvider(rt, environment);
  const attempt = await withActor(rt.db, fa.ctx, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId))
      .for('update');
    if (!invoice) throw new ApiError('not_found', 'invoice not found');
    assertOrg(fa, 'org.invoices.pay', {
      type: 'invoice',
      id: invoice.id,
      organizationId: invoice.organizationId,
    });
    if (!['issued', 'partially_paid', 'overdue'].includes(invoice.status)) {
      throw new ApiError(
        'invalid_transition',
        `invoice ${invoice.number} is ${invoice.status} and cannot be paid`,
      );
    }
    const balance = invoiceBalance(invoice);
    if (balance <= 0n) throw new ApiError('conflict', 'this invoice has no outstanding balance');
    let amountKobo = balance;
    const plan = (invoice.installmentPlan as Installment[] | null) ?? null;
    if (input.installmentIndex !== undefined) {
      const installment = plan?.[input.installmentIndex];
      if (!installment) throw new ApiError('validation_failed', 'unknown installment');
      amountKobo = BigInt(installment.amountKobo);
    } else if (input.amountKobo !== undefined) {
      const requested = BigInt(input.amountKobo);
      const permitted =
        requested === balance || (plan?.some((i) => BigInt(i.amountKobo) === requested) ?? false);
      if (!permitted) {
        throw new ApiError(
          'validation_failed',
          'partial payments must match an installment or the full balance',
          {
            details: { balanceKobo: balance.toString() },
          },
        );
      }
      amountKobo = requested;
    }
    if (amountKobo <= 0n || amountKobo > balance) {
      throw new ApiError(
        'validation_failed',
        'amount must be positive and no more than the outstanding balance',
        {
          details: { balanceKobo: balance.toString() },
        },
      );
    }
    const [row] = await tx
      .insert(schema.paymentAttempts)
      .values({
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        provider: resolved.kind,
        environment: resolved.environment,
        reference: newAttemptReference(),
        amountKobo,
        currency: invoice.currency,
        status: 'initialized',
        initiatedByUserId: userId,
      })
      .returning();
    await recordAudit(tx, fa, {
      action: 'payment_attempt.created',
      entityType: 'payment_attempt',
      entityId: row!.id,
      organizationId: invoice.organizationId,
      after: {
        invoiceId: invoice.id,
        amountKobo,
        currency: invoice.currency,
        provider: resolved.kind,
        environment: resolved.environment,
      },
    });
    return row!;
  });

  const [user] = await withActor(rt.db, fa.ctx, (tx) =>
    tx.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId)),
  );
  const callbackUrl = new URL(CALLBACK_PATH, rt.appUrl);
  callbackUrl.searchParams.set('reference', attempt.reference);
  try {
    const init = await resolved.provider.initialize({
      reference: attempt.reference,
      amountKobo: attempt.amountKobo,
      currency: attempt.currency,
      email: user?.email ?? 'unknown@example.invalid',
      callbackUrl: callbackUrl.toString(),
      metadata: { invoiceId: attempt.invoiceId, paymentAttemptId: attempt.id },
      ...(input.channels ? { channels: input.channels as PaymentChannel[] } : {}),
    });
    return withActor(rt.db, fa.ctx, async (tx) => {
      const [updated] = await tx
        .update(schema.paymentAttempts)
        .set({
          status: 'pending',
          authorizationUrl: init.authorizationUrl,
          accessCode: init.accessCode,
          providerReference: init.providerReference,
          version: attempt.version + 1,
        })
        .where(eq(schema.paymentAttempts.id, attempt.id))
        .returning();
      await emitEvent(tx, fa, {
        eventType: 'payment.initialized',
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        organizationId: attempt.organizationId,
        payload: {
          paymentAttemptId: attempt.id,
          invoiceId: attempt.invoiceId,
          amountKobo: attempt.amountKobo,
          provider: resolved.kind,
        },
      });
      return toPaymentAttemptDto(updated!);
    });
  } catch (err) {
    const api = providerErrorToApi(err);
    await withActor(rt.db, fa.ctx, (tx) =>
      tx
        .update(schema.paymentAttempts)
        .set({
          status: 'failed',
          failureReason: `initialize failed: ${api.message}`.slice(0, 500),
          version: attempt.version + 1,
        })
        .where(eq(schema.paymentAttempts.id, attempt.id)),
    );
    throw api;
  }
}

async function loadAttemptForActor(
  rt: FinanceRuntime,
  fa: FinanceActor,
  selector: { id?: string; reference?: string },
) {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const where = selector.id
      ? eq(schema.paymentAttempts.id, selector.id)
      : eq(schema.paymentAttempts.reference, selector.reference ?? '');
    const [attempt] = await tx.select().from(schema.paymentAttempts).where(where);
    if (!attempt) throw new ApiError('not_found', 'payment attempt not found');
    assertStaffOrOrg(fa, 'finance.read', 'org.invoices.view', {
      type: 'invoice',
      id: attempt.invoiceId,
      organizationId: attempt.organizationId,
    });
    return attempt;
  });
}

export async function getPaymentAttempt(
  rt: FinanceRuntime,
  fa: FinanceActor,
  id: string,
): Promise<PaymentAttemptDto> {
  return toPaymentAttemptDto(await loadAttemptForActor(rt, fa, { id }));
}

/** The provider an existing attempt was created with; a test attempt is never verified with live credentials or vice versa. */
export async function providerForAttempt(
  rt: FinanceRuntime,
  attempt: PaymentAttemptRow,
): Promise<ResolvedProvider> {
  if (attempt.provider === 'bank_transfer') {
    throw new ApiError(
      'validation_failed',
      'bank transfers are confirmed by finance, not verified with a gateway',
    );
  }
  const environment = attempt.environment === 'live' ? 'live' : 'test';
  const resolved = await requireProvider(rt, environment);
  if (resolved.kind !== attempt.provider) {
    throw new ApiError(
      'provider_not_configured',
      'the provider this attempt was created with is no longer configured',
      {
        details: { attemptProvider: attempt.provider, configured: resolved.kind },
      },
    );
  }
  return resolved;
}

const CUSTOMER_MESSAGES: Record<MatchOutcome['decision'], string> = {
  settle: 'Payment received. Thank you.',
  fail: 'The payment did not complete. You can try again.',
  keep_pending: 'The payment is still being confirmed by the payment provider.',
  mark_uncertain:
    'We could not confirm this payment yet. Our finance team will reconcile it; you will not be charged twice.',
  mismatch:
    'The payment details reported by the provider do not match this invoice. Our finance team will review it before anything is applied.',
  reverse: 'The provider reversed this payment. Finance will review the invoice.',
  no_change: 'No change to this payment.',
};

/**
 * Applies a provider verification to an attempt: the single decision point
 * for the customer verify endpoint, the callback, the webhook job and the
 * reconciliation job. Settlement is delegated to `settleAttempt`; every other
 * decision changes attempt status only and never allocates money.
 */
export async function applyVerification(
  rt: FinanceRuntime,
  attempt: PaymentAttemptRow,
  verification: VerifyResult,
  options: {
    source: 'verify' | 'callback' | 'webhook' | 'reconcile';
    actorUserId?: string | null;
    correlationId?: string;
  },
): Promise<{
  attempt: PaymentAttemptRow;
  outcome: MatchOutcome;
  receiptNumber: string | null;
  invoiceStatus: PaymentVerifyResult['invoiceStatus'];
}> {
  const ageSeconds = Math.max(0, (rt.now().getTime() - attempt.createdAt.getTime()) / 1000);
  const outcome = matchVerification({
    attempt: {
      reference: attempt.reference,
      amountKobo: attempt.amountKobo,
      currency: attempt.currency,
      status: attempt.status,
    },
    verification,
    ageSeconds,
  });
  const envMismatch =
    verification.environment !== 'unknown' && verification.environment !== attempt.environment;
  const common = {
    attemptId: attempt.id,
    verification,
    source: options.source,
    actorUserId: options.actorUserId ?? null,
    correlationId: options.correlationId,
  };
  const system = systemFinanceActor(options.correlationId);
  const invoiceStatus = async () =>
    withActor(rt.db, system.ctx, async (tx) => {
      const [inv] = await tx
        .select({ status: schema.invoices.status })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, attempt.invoiceId));
      if (!inv) throw new ApiError('not_found', 'invoice not found');
      return inv.status;
    });
  if (envMismatch && (outcome.decision === 'settle' || outcome.decision === 'no_change')) {
    const updated = await recordAttemptOutcome(rt, {
      ...common,
      status: attempt.status === 'successful' ? 'uncertain' : 'uncertain',
      reasons: [
        `environment_mismatch: provider reported ${verification.environment}, attempt is ${attempt.environment}`,
      ],
      exceptionCode: 'environment_mismatch',
    });
    return {
      attempt: updated,
      outcome: { decision: 'mismatch', reasons: ['environment mismatch'] },
      receiptNumber: null,
      invoiceStatus: await invoiceStatus(),
    };
  }
  switch (outcome.decision) {
    case 'settle': {
      const result = await settleAttempt(rt, common);
      return {
        attempt: result.attempt,
        outcome,
        receiptNumber: result.receiptNumber,
        invoiceStatus: result.invoiceStatus,
      };
    }
    case 'fail': {
      const updated = await recordAttemptOutcome(rt, {
        ...common,
        status: outcome.targetStatus === 'abandoned' ? 'abandoned' : 'failed',
        reasons: outcome.reasons,
      });
      return {
        attempt: updated,
        outcome,
        receiptNumber: null,
        invoiceStatus: await invoiceStatus(),
      };
    }
    case 'keep_pending': {
      const updated = await recordAttemptOutcome(rt, {
        ...common,
        status: attempt.status === 'uncertain' ? 'uncertain' : 'pending',
        reasons: outcome.reasons,
      });
      return {
        attempt: updated,
        outcome,
        receiptNumber: null,
        invoiceStatus: await invoiceStatus(),
      };
    }
    case 'mark_uncertain': {
      const updated = await recordAttemptOutcome(rt, {
        ...common,
        status: 'uncertain',
        reasons: outcome.reasons,
        exceptionCode: 'verification_uncertain',
      });
      return {
        attempt: updated,
        outcome,
        receiptNumber: null,
        invoiceStatus: await invoiceStatus(),
      };
    }
    case 'mismatch': {
      const status =
        attempt.status === 'successful' ||
        ['failed', 'abandoned', 'reversed'].includes(attempt.status)
          ? attempt.status
          : 'uncertain';
      const updated = await recordAttemptOutcome(rt, {
        ...common,
        status:
          status === 'successful' ? 'uncertain' : (status as 'uncertain' | 'failed' | 'abandoned'),
        reasons: outcome.reasons,
        exceptionCode: 'verification_mismatch',
      });
      return {
        attempt: updated,
        outcome,
        receiptNumber: null,
        invoiceStatus: await invoiceStatus(),
      };
    }
    case 'reverse': {
      const updated = await reverseSettledAttempt(rt, {
        attemptId: attempt.id,
        verification,
        source: options.source,
        correlationId: options.correlationId,
      });
      return {
        attempt: updated,
        outcome,
        receiptNumber: null,
        invoiceStatus: await invoiceStatus(),
      };
    }
    case 'no_change':
    default: {
      const receipt = await withActor(rt.db, system.ctx, (tx) =>
        tx
          .select({ number: schema.receipts.number })
          .from(schema.receipts)
          .innerJoin(schema.allocations, eq(schema.allocations.id, schema.receipts.allocationId))
          .where(eq(schema.allocations.paymentAttemptId, attempt.id)),
      );
      return {
        attempt,
        outcome,
        receiptNumber: receipt[0]?.number ?? null,
        invoiceStatus: await invoiceStatus(),
      };
    }
  }
}

/** Customer or staff asks the server to verify with the provider; a redirect never settles by itself. */
export async function verifyPaymentAttempt(
  rt: FinanceRuntime,
  fa: FinanceActor,
  selector: { id?: string; reference?: string },
  options: { source: 'verify' | 'callback' } = { source: 'verify' },
): Promise<PaymentVerifyResult> {
  const attempt = await loadAttemptForActor(rt, fa, selector);
  const resolved = await providerForAttempt(rt, attempt);
  let verification: VerifyResult;
  try {
    verification = await resolved.provider.verify(attempt.reference);
  } catch (err) {
    throw providerErrorToApi(err);
  }
  const result = await applyVerification(rt, attempt, verification, {
    source: options.source,
    actorUserId: fa.actor.userId,
    correlationId: fa.correlationId,
  });
  return {
    attempt: toPaymentAttemptDto(result.attempt),
    decision: result.outcome.decision,
    invoiceStatus: result.invoiceStatus,
    receiptNumber: result.receiptNumber,
    message: CUSTOMER_MESSAGES[result.outcome.decision],
  };
}

/** Worker/system verification by reference (webhook `verify_and_settle`, reconciliation). */
export async function verifyAttemptAsSystem(
  rt: FinanceRuntime,
  reference: string,
  options: { source: 'webhook' | 'reconcile'; correlationId?: string },
): Promise<ReturnType<typeof applyVerification> extends Promise<infer T> ? T : never> {
  const system = systemFinanceActor(options.correlationId);
  const attempt = await withActor(rt.db, system.ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.reference, reference));
    if (!row) throw new ApiError('not_found', `payment attempt ${reference} not found`);
    return row;
  });
  const resolved = await providerForAttempt(rt, attempt);
  const verification = await resolved.provider.verify(attempt.reference);
  return applyVerification(rt, attempt, verification, {
    source: options.source,
    correlationId: options.correlationId,
  });
}

export { elevated };
