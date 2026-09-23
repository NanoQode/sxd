import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, systemContext, withActor } from '@simplexd/db';
import {
  DEV_SMS_WEBHOOK_SECRET,
  TERMII_SIGNATURE_HEADER,
  classifyInboundKeyword,
  getHeader,
  normalizeToE164,
  parseTermiiJson,
  parseTermiiWebhookPayload,
  verifyTermiiSignature,
  type SmsDeliveryState,
  type WebhookHeaders,
} from '@simplexd/integrations/sms';
import { resolveEnv } from './env';
import { resolveSmsProvider } from './providers';
import type { Db, DeliveryStatus, PipelineOptions } from './types';

/**
 * Delivery receipts and inbound replies from Termii, plus SMTP bounce intake.
 * Receipts move an attempt from `accepted` to `delivered`/`failed`/`rejected`;
 * STOP/START keywords write `sms_consents` and `suppressions` so every future
 * campaign honours the reply.
 */

export interface WebhookOutcome {
  /** HTTP status the route should answer with. */
  status: number;
  accepted: boolean;
  signature: 'valid' | 'invalid' | 'unchecked';
  eventType: string;
  action: string;
  attemptId?: string | null;
  reason?: string | null;
}

const DELIVERY_STATE_TO_STATUS: Record<SmsDeliveryState, DeliveryStatus | null> = {
  delivered: 'delivered',
  failed: 'failed',
  rejected: 'rejected',
  expired: 'failed',
  sent: 'sent',
  unknown: null,
};

export async function processTermiiWebhook(
  db: Db,
  rawBody: string,
  headers: WebhookHeaders,
  options: PipelineOptions = {},
): Promise<WebhookOutcome> {
  const env = resolveEnv(options);
  const sms = await resolveSmsProvider(db, env);
  const secret = sms.adapter === 'dev' ? DEV_SMS_WEBHOOK_SECRET : sms.webhookSecret;
  const header = getHeader(headers, TERMII_SIGNATURE_HEADER);
  let signature: WebhookOutcome['signature'] = 'unchecked';
  if (secret) {
    signature = verifyTermiiSignature(rawBody, header, secret) ? 'valid' : 'invalid';
  }
  const log = async (event: string, message: string, metadata: Record<string, unknown> = {}) => {
    await withActor(db, systemContext('termii-webhook'), (tx) =>
      tx.insert(schema.integrationLogs).values({
        provider: 'termii',
        environment: sms.environment,
        level: event.endsWith('rejected') ? 'warn' : 'info',
        event,
        messageSanitized: message,
        metadataSanitized: { signature, ...metadata },
      }),
    );
  };
  if (signature === 'invalid') {
    await log('webhook.rejected', 'signature mismatch');
    return {
      status: 401,
      accepted: false,
      signature,
      eventType: 'unknown',
      action: 'rejected',
      reason: 'invalid_signature',
    };
  }
  if (signature === 'unchecked' && env.production) {
    await log('webhook.rejected', 'no webhook secret configured; refused in production');
    return {
      status: 403,
      accepted: false,
      signature,
      eventType: 'unknown',
      action: 'rejected',
      reason: 'signature_unchecked',
    };
  }
  let payload: unknown;
  try {
    payload = parseTermiiJson(rawBody);
  } catch {
    await log('webhook.rejected', 'body is not JSON');
    return {
      status: 400,
      accepted: false,
      signature,
      eventType: 'unknown',
      action: 'rejected',
      reason: 'invalid_json',
    };
  }
  const event = parseTermiiWebhookPayload(payload);
  const now = env.now();

  if (event.type === 'outbound' && event.providerMessageId) {
    const target = DELIVERY_STATE_TO_STATUS[event.deliveryState];
    const updated = await withActor(db, systemContext('termii-webhook'), async (tx) => {
      const [attempt] = await tx
        .select()
        .from(schema.deliveryAttempts)
        .where(
          and(
            eq(schema.deliveryAttempts.channel, 'sms'),
            eq(schema.deliveryAttempts.providerMessageId, event.providerMessageId!),
          ),
        )
        .orderBy(desc(schema.deliveryAttempts.createdAt))
        .limit(1);
      if (!attempt) return null;
      // Never regress a delivered attempt; `unknown` states only refresh the provider text.
      const nextStatus = target && attempt.status !== 'delivered' ? target : attempt.status;
      await tx
        .update(schema.deliveryAttempts)
        .set({
          status: nextStatus,
          providerStatus: event.providerStatus ?? attempt.providerStatus,
          deliveredAt: nextStatus === 'delivered' ? (event.occurredAt ?? now) : attempt.deliveredAt,
          failedAt:
            nextStatus === 'failed' || nextStatus === 'rejected'
              ? (event.occurredAt ?? now)
              : attempt.failedAt,
          errorSanitized:
            nextStatus === 'failed' || nextStatus === 'rejected'
              ? (event.providerStatus ?? nextStatus).slice(0, 500)
              : attempt.errorSanitized,
        })
        .where(eq(schema.deliveryAttempts.id, attempt.id));
      return attempt.id;
    });
    await log('webhook.receipt', `delivery state ${event.deliveryState}`, {
      matched: Boolean(updated),
    });
    return {
      status: 200,
      accepted: true,
      signature,
      eventType: 'outbound',
      action: updated ? `attempt:${target ?? 'unchanged'}` : 'no_matching_attempt',
      attemptId: updated,
    };
  }

  if (event.type === 'inbound') {
    const keyword = classifyInboundKeyword(event.inboundText);
    const phone = event.sender ? normalizeToE164(event.sender) : null;
    if (!keyword || !phone || !phone.ok) {
      await log('webhook.inbound', 'inbound message without keyword');
      return { status: 200, accepted: true, signature, eventType: 'inbound', action: 'ignored' };
    }
    if (keyword === 'opt_out') await recordSmsOptOut(db, phone.e164, 'termii_inbound_stop');
    else await recordSmsOptIn(db, phone.e164, 'termii_inbound_start');
    await log('webhook.inbound', `keyword ${keyword}`);
    return { status: 200, accepted: true, signature, eventType: 'inbound', action: keyword };
  }

  await log('webhook.received', `event type ${event.type}`);
  return { status: 200, accepted: true, signature, eventType: event.type, action: 'ignored' };
}

/** STOP: opt out of every SMS category and suppress the number for all campaigns. */
export async function recordSmsOptOut(
  db: Db,
  phoneE164: string,
  source: string,
  userId: string | null = null,
): Promise<void> {
  await withActor(db, systemContext('sms-consent'), async (tx) => {
    const owner = userId ?? (await userIdForPhone(tx, phoneE164));
    await tx.insert(schema.smsConsents).values(
      (['transactional', 'marketing', 'reminders', 'digests'] as const).map((category) => ({
        phoneE164,
        userId: owner,
        category,
        status: 'opted_out' as const,
        source,
      })),
    );
    await tx
      .insert(schema.suppressions)
      .values({ channel: 'sms', address: phoneE164, reason: 'stop_keyword', source })
      .onConflictDoUpdate({
        target: [schema.suppressions.channel, schema.suppressions.address],
        set: { reason: 'stop_keyword', source, createdAt: sql`now()` },
      });
  });
}

/** START: lifts a STOP suppression and records opt-in for transactional and marketing SMS. */
export async function recordSmsOptIn(
  db: Db,
  phoneE164: string,
  source: string,
  userId: string | null = null,
): Promise<void> {
  await withActor(db, systemContext('sms-consent'), async (tx) => {
    const owner = userId ?? (await userIdForPhone(tx, phoneE164));
    await tx.insert(schema.smsConsents).values(
      (['transactional', 'marketing'] as const).map((category) => ({
        phoneE164,
        userId: owner,
        category,
        status: 'opted_in' as const,
        source,
      })),
    );
    await tx
      .delete(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.channel, 'sms'),
          eq(schema.suppressions.address, phoneE164),
          inArray(schema.suppressions.reason, ['stop_keyword', 'opt_out']),
        ),
      );
  });
}

async function userIdForPhone(
  tx: Parameters<Parameters<typeof withActor>[2]>[0],
  phoneE164: string,
): Promise<string | null> {
  const [profile] = await tx
    .select({ userId: schema.userProfiles.userId })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.phoneE164, phoneE164))
    .limit(1);
  return profile?.userId ?? null;
}

export interface BounceInput {
  email: string;
  /** `hard`, `soft`, `complaint` or a provider reason; hard bounces and complaints suppress. */
  kind: 'hard' | 'soft' | 'complaint';
  reason?: string | null;
  providerMessageId?: string | null;
  source?: string | null;
}

/**
 * SMTP bounce intake (manual import or a future provider webhook). Marks the
 * matching attempt `bounced` and suppresses the address for hard bounces and
 * complaints; soft bounces are recorded on the attempt only.
 */
export async function processBounce(
  db: Db,
  input: BounceInput,
  options: PipelineOptions = {},
): Promise<{ attemptId: string | null; suppressed: boolean }> {
  const env = resolveEnv(options);
  const email = input.email.trim().toLowerCase();
  const now = env.now();
  return withActor(db, systemContext('mail-bounce'), async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.deliveryAttempts)
      .where(
        and(
          eq(schema.deliveryAttempts.channel, 'email'),
          input.providerMessageId
            ? eq(schema.deliveryAttempts.providerMessageId, input.providerMessageId)
            : eq(schema.deliveryAttempts.recipient, email),
        ),
      )
      .orderBy(desc(schema.deliveryAttempts.createdAt))
      .limit(1);
    if (attempt) {
      await tx
        .update(schema.deliveryAttempts)
        .set({
          status: 'bounced',
          failedAt: now,
          errorSanitized: `${input.kind} bounce${input.reason ? `: ${input.reason.slice(0, 300)}` : ''}`,
        })
        .where(eq(schema.deliveryAttempts.id, attempt.id));
    }
    const suppress = input.kind !== 'soft';
    if (suppress) {
      await tx
        .insert(schema.suppressions)
        .values({
          channel: 'email',
          address: email,
          reason: input.kind === 'complaint' ? 'complaint' : 'hard_bounce',
          source: input.source ?? 'bounce_import',
        })
        .onConflictDoNothing();
    }
    return { attemptId: attempt?.id ?? null, suppressed: suppress };
  });
}
