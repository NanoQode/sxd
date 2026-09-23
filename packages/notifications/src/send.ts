import { eq, sql } from 'drizzle-orm';
import { enqueueJob, sanitizeError, schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { analyzeSegments, type SmsCategory } from '@simplexd/integrations/sms';
import type { PipelineEnv } from './env';
import {
  PROVIDER_NOT_CONFIGURED,
  resolveMailProvider,
  resolveSmsProvider,
  type ResolvedMailProvider,
  type ResolvedSmsProvider,
} from './providers';
import type { Db, DeliveryStatus } from './types';

/** Message handed to a provider; stored in the deferred job payload as-is. */
export type OutboundMessage =
  | {
      channel: 'email';
      to: string;
      toName?: string | null;
      subject: string;
      text: string;
      html: string;
      tags?: string[];
    }
  | { channel: 'sms'; to: string; body: string; category: SmsCategory };

export interface SendOutcome {
  status: DeliveryStatus;
  provider: string;
  environment: 'test' | 'live';
  providerMessageId: string | null;
  providerStatus: string | null;
  errorSanitized: string | null;
  retryable: boolean;
  segments: number | null;
  estimatedCostKobo: number | null;
}

/** Lazily resolves each provider once per pipeline call. */
export class ProviderSet {
  private mail: Promise<ResolvedMailProvider> | null = null;
  private sms: Promise<ResolvedSmsProvider> | null = null;
  constructor(
    private readonly db: Db,
    private readonly env: PipelineEnv,
  ) {}
  getMail(): Promise<ResolvedMailProvider> {
    this.mail ??= resolveMailProvider(this.db, this.env);
    return this.mail;
  }
  getSms(): Promise<ResolvedSmsProvider> {
    this.sms ??= resolveSmsProvider(this.db, this.env);
    return this.sms;
  }
}

export const DEFERRED_QUEUE = 'notifications-deferred';
export const DEFERRED_JOB_TYPE = 'notifications.send_deferred';

export function smsCostKobo(body: string, unitCostKobo: number | null | undefined): {
  segments: number;
  estimatedCostKobo: number;
} {
  const segments = analyzeSegments(body).segments;
  return { segments, estimatedCostKobo: segments * (unitCostKobo ?? 400) };
}

/**
 * Sends one message through the active provider. Never throws for provider
 * errors: the outcome carries a sanitised reason and whether a retry is
 * worthwhile. `provider_not_configured` is a permanent failure that the
 * delivery log shows verbatim.
 */
export async function sendOutbound(
  message: OutboundMessage,
  idempotencyKey: string,
  providers: ProviderSet,
): Promise<SendOutcome> {
  if (message.channel === 'email') {
    const mail = await providers.getMail();
    if (!mail.provider) {
      return {
        status: 'failed',
        provider: mail.adapter === 'none' ? 'smtp' : mail.adapter,
        environment: mail.environment,
        providerMessageId: null,
        providerStatus: null,
        errorSanitized: mail.reason ?? PROVIDER_NOT_CONFIGURED,
        retryable: false,
        segments: null,
        estimatedCostKobo: null,
      };
    }
    try {
      const result = await mail.provider.send({
        to: [{ email: message.to, ...(message.toName ? { name: message.toName } : {}) }],
        from: mail.from,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        html: message.html,
        tags: message.tags ?? [],
        idempotencyKey,
      });
      return {
        // SMTP acceptance is not delivery: `sent` means the relay took the message.
        status: result.accepted ? 'sent' : 'failed',
        provider: mail.adapter,
        environment: mail.environment,
        providerMessageId: result.providerMessageId,
        providerStatus: result.response,
        errorSanitized: result.accepted ? null : (result.errorSanitized ?? 'send rejected'),
        retryable: !result.accepted && Boolean(result.retryable),
        segments: null,
        estimatedCostKobo: null,
      };
    } catch (err) {
      return {
        status: 'failed',
        provider: mail.adapter,
        environment: mail.environment,
        providerMessageId: null,
        providerStatus: null,
        errorSanitized: sanitizeError(err).slice(0, 500),
        retryable: true,
        segments: null,
        estimatedCostKobo: null,
      };
    }
  }
  const sms = await providers.getSms();
  const cost = smsCostKobo(message.body, sms.settings?.unitCostKobo);
  if (!sms.provider) {
    return {
      status: 'failed',
      provider: sms.adapter === 'none' ? 'termii' : sms.adapter,
      environment: sms.environment,
      providerMessageId: null,
      providerStatus: null,
      errorSanitized: sms.reason ?? PROVIDER_NOT_CONFIGURED,
      retryable: false,
      segments: cost.segments,
      estimatedCostKobo: cost.estimatedCostKobo,
    };
  }
  try {
    const result = await sms.provider.send({
      to: message.to,
      from: sms.senderId,
      body: message.body,
      category: message.category,
      idempotencyKey,
    });
    return {
      // Provider acceptance; delivery is only recorded from a receipt.
      status: result.accepted ? 'accepted' : 'failed',
      provider: sms.adapter,
      environment: sms.environment,
      providerMessageId: result.providerMessageId,
      providerStatus: result.providerStatus,
      errorSanitized: result.accepted ? null : (result.errorSanitized ?? 'send rejected'),
      retryable: !result.accepted && Boolean(result.retryable),
      segments: cost.segments,
      estimatedCostKobo: result.accepted ? cost.estimatedCostKobo : 0,
    };
  } catch (err) {
    return {
      status: 'failed',
      provider: sms.adapter,
      environment: sms.environment,
      providerMessageId: null,
      providerStatus: null,
      errorSanitized: sanitizeError(err).slice(0, 500),
      retryable: true,
      segments: cost.segments,
      estimatedCostKobo: 0,
    };
  }
}

/** Writes a provider outcome onto the attempt row. */
export async function recordSendOutcome(
  tx: DbExecutor,
  attemptId: string,
  outcome: SendOutcome,
  now: Date,
): Promise<void> {
  const terminalFailure = outcome.status === 'failed' && !outcome.retryable;
  await tx
    .update(schema.deliveryAttempts)
    .set({
      status: outcome.retryable ? 'queued' : outcome.status,
      provider: outcome.provider,
      environment: outcome.environment,
      providerMessageId: outcome.providerMessageId,
      providerStatus: outcome.providerStatus,
      errorSanitized: outcome.errorSanitized,
      segments: outcome.segments,
      estimatedCostKobo: outcome.estimatedCostKobo === null ? null : BigInt(outcome.estimatedCostKobo),
      sentAt: outcome.status === 'sent' || outcome.status === 'accepted' ? now : null,
      failedAt: terminalFailure ? now : null,
      attempts: sql`${schema.deliveryAttempts.attempts} + 1`,
    })
    .where(eq(schema.deliveryAttempts.id, attemptId));
}

export interface DeferredJobPayload {
  attemptId: string;
  idempotencyKey: string;
  message: OutboundMessage;
}

/** Queues a quiet-hours deferral: the attempt stays `queued` with `queued_at` = send time. */
export async function scheduleDeferredSend(
  tx: DbExecutor,
  input: DeferredJobPayload & { sendAt: Date; dedupeKey: string; organizationId?: string | null; correlationId?: string | null },
): Promise<void> {
  await tx
    .update(schema.deliveryAttempts)
    .set({ status: 'queued', queuedAt: input.sendAt, errorSanitized: 'quiet_hours', providerStatus: 'deferred' })
    .where(eq(schema.deliveryAttempts.id, input.attemptId));
  const payload: DeferredJobPayload = {
    attemptId: input.attemptId,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
  };
  await enqueueJob(tx, {
    type: DEFERRED_JOB_TYPE,
    queue: DEFERRED_QUEUE,
    payload: payload as unknown as Record<string, unknown>,
    runAt: input.sendAt,
    dedupeKey: `deferred:${input.dedupeKey}`,
    organizationId: input.organizationId ?? null,
    correlationId: input.correlationId ?? null,
    maxAttempts: 5,
  });
}

/** Executes a deferred payload (from `notifications.send_deferred` or the reminder sweep). */
export async function executeDeferredSend(
  db: Db,
  payload: DeferredJobPayload,
  env: PipelineEnv,
  providers = new ProviderSet(db, env),
): Promise<SendOutcome | null> {
  const attempt = await withActor(db, systemContext('notifications'), (tx) =>
    tx.select().from(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.id, payload.attemptId)),
  );
  const row = attempt[0];
  if (!row || row.status !== 'queued') return null;
  const outcome = await sendOutbound(payload.message, payload.idempotencyKey, providers);
  await withActor(db, systemContext('notifications'), (tx) =>
    recordSendOutcome(tx, row.id, outcome, env.now()),
  );
  return outcome;
}
