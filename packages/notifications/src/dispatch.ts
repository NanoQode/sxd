import { eq } from 'drizzle-orm';
import { schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import type { TemplateVariables } from '@simplexd/integrations/templates';
import { resolveEnv, type PipelineEnv } from './env';
import { evaluateChannelPolicy, loadPolicyFacts, smsCategoryFor, type PolicyDecision } from './policy';
import { resolveRecipients } from './recipients';
import {
  ProviderSet,
  recordSendOutcome,
  scheduleDeferredSend,
  sendOutbound,
  smsCostKobo,
  type OutboundMessage,
} from './send';
import { loadTemplate, renderForChannel, type RenderedMessage } from './templates';
import type {
  AttemptOutcome,
  Db,
  DispatchResult,
  NotificationChannel,
  NotificationRequest,
  PipelineOptions,
  ResolvedRecipient,
} from './types';

/**
 * Dispatches one notification request: resolve people, apply policy per
 * channel, render, record a delivery attempt and send. Idempotent on
 * `dedupeScope × recipient × channel`: a replayed outbox event finds the
 * existing attempt and only resends when a previous try was retryable.
 */
export async function dispatchRequest(
  db: Db,
  request: NotificationRequest,
  options: PipelineOptions = {},
): Promise<DispatchResult> {
  const env = resolveEnv(options);
  const providers = new ProviderSet(db, env);
  const outcomes: AttemptOutcome[] = [];
  const recipients = await withActor(db, systemContext('notifications'), (tx) =>
    resolveRecipients(tx, request.recipients),
  );
  if (recipients.length === 0) {
    env.log.info({ templateKey: request.templateKey, scope: request.dedupeScope }, 'no recipients');
    return { outcomes, retryable: false };
  }
  const channels = [...new Set(request.channels)];
  for (const recipient of recipients) {
    const variables =
      typeof request.variables === 'function' ? request.variables(recipient) : request.variables;
    for (const channel of channels) {
      try {
        outcomes.push(await dispatchChannel(db, env, providers, request, recipient, channel, variables));
      } catch (err) {
        env.log.error(
          { err, channel, templateKey: request.templateKey, scope: request.dedupeScope },
          'notification channel dispatch failed',
        );
        outcomes.push({
          attemptId: null,
          channel,
          recipient: addressFor(recipient, channel) ?? 'unknown',
          status: 'failed',
          reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
          retryable: true,
        });
      }
    }
  }
  return { outcomes, retryable: outcomes.some((o) => o.retryable) };
}

function addressFor(recipient: ResolvedRecipient, channel: NotificationChannel): string | null {
  if (channel === 'email') return recipient.email;
  if (channel === 'sms') return recipient.phoneE164;
  return recipient.userId;
}

async function dispatchChannel(
  db: Db,
  env: PipelineEnv,
  providers: ProviderSet,
  request: NotificationRequest,
  recipient: ResolvedRecipient,
  channel: NotificationChannel,
  variables: TemplateVariables,
): Promise<AttemptOutcome> {
  const address = addressFor(recipient, channel);
  const dedupeKey = `${request.dedupeScope}:${recipient.userId ?? address ?? 'anon'}:${channel}`;
  const now = env.now();
  const smsSettings = channel === 'sms' ? (await providers.getSms()).settings : null;

  // Phase 1 (transaction): policy, template, render, attempt row.
  const prepared = await withActor(db, systemContext(request.correlationId ?? 'notifications'), async (tx) => {
    const existing = await tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.dedupeKey, dedupeKey));
    const prior = existing[0];
    // A prior row is final unless it is still queued for an immediate retry
    // (deferred rows carry providerStatus `deferred` and belong to the reminder sweep).
    const retryable = prior?.status === 'queued' && prior.providerStatus !== 'deferred';
    if (prior && !retryable) return { kind: 'deduplicated' as const, prior };
    const facts = await loadPolicyFacts(tx, recipient, now);
    const template = await loadTemplate(
      tx,
      { key: request.templateKey, channel, locale: recipient.locale },
      env,
    );
    let rendered: RenderedMessage | null = null;
    let failure: string | null = null;
    if (!template) {
      if (channel === 'in_app' && request.inApp?.title) {
        rendered = { channel: 'in_app', title: request.inApp.title, body: request.inApp.body ?? null };
      } else {
        failure = env.production ? 'template_not_approved' : 'template_missing';
      }
    } else {
      const outcome = renderForChannel(template, variables, env);
      if (outcome.ok) rendered = outcome.message;
      else failure = outcome.reason;
    }
    const estimated =
      rendered?.channel === 'sms' ? smsCostKobo(rendered.body, smsSettings?.unitCostKobo) : null;
    const decision: PolicyDecision = failure
      ? { action: 'suppress', reason: failure }
      : evaluateChannelPolicy({
          channel,
          category: request.category,
          templateKey: request.templateKey,
          recipient,
          facts,
          now,
          smsSettings,
          estimatedCostKobo: estimated?.estimatedCostKobo ?? 0,
          ignorePreferences: request.ignorePreferences,
        });
    const attemptId = prior?.id ?? (await insertAttempt(tx, {
      channel,
      category: request.category,
      templateKey: request.templateKey,
      templateVersion: template?.row.version ?? null,
      recipient: address ?? recipient.name,
      userId: recipient.userId,
      provider: channel === 'email' ? 'smtp' : channel === 'sms' ? 'termii' : 'in_app',
      environment: env.production ? 'live' : 'test',
      dedupeKey,
      relatedEntityType: request.label === 'test' ? 'test_send' : (request.relatedEntity?.type ?? null),
      relatedEntityId: request.relatedEntity?.id ?? null,
      subject: rendered?.channel === 'email' ? rendered.subject : rendered?.channel === 'in_app' ? rendered.title : null,
      segments: estimated?.segments ?? null,
      estimatedCostKobo: estimated?.estimatedCostKobo ?? null,
      now,
    }));
    if (!attemptId) return { kind: 'deduplicated' as const, prior: null };

    if (failure || decision.action === 'suppress' || decision.action === 'digest') {
      const status = failure ? 'failed' : 'suppressed';
      await tx
        .update(schema.deliveryAttempts)
        .set({ status, errorSanitized: decision.reason, failedAt: failure ? now : null })
        .where(eq(schema.deliveryAttempts.id, attemptId));
      return { kind: 'settled' as const, attemptId, status, reason: decision.reason };
    }

    if (channel === 'in_app') {
      const message = rendered as Extract<RenderedMessage, { channel: 'in_app' }>;
      await tx
        .insert(schema.notifications)
        .values({
          userId: recipient.userId!,
          organizationId: request.organizationId ?? null,
          category: request.category,
          kind: request.inApp?.kind ?? request.templateKey,
          title: message.title,
          body: request.inApp?.body ?? message.body,
          linkPath: request.inApp?.linkPath ?? null,
          entityType: request.inApp?.entityType ?? request.relatedEntity?.type ?? null,
          entityId: request.inApp?.entityId ?? request.relatedEntity?.id ?? null,
          dedupeKey,
        })
        .onConflictDoNothing();
      await tx
        .update(schema.deliveryAttempts)
        .set({ status: 'delivered', provider: 'in_app', deliveredAt: now, sentAt: now, attempts: 1 })
        .where(eq(schema.deliveryAttempts.id, attemptId));
      return { kind: 'settled' as const, attemptId, status: 'delivered' as const, reason: null };
    }

    const message: OutboundMessage =
      rendered!.channel === 'email'
        ? {
            channel: 'email',
            to: address!,
            toName: recipient.name,
            subject: rendered!.subject,
            text: rendered!.text,
            html: rendered!.html,
            tags: [request.templateKey, request.category, ...(request.label ? [request.label] : [])],
          }
        : { channel: 'sms', to: address!, body: rendered!.body, category: smsCategoryFor(request.category) };

    if (decision.action === 'defer' && decision.deferUntil) {
      await scheduleDeferredSend(tx, {
        attemptId,
        idempotencyKey: dedupeKey,
        message,
        sendAt: decision.deferUntil,
        dedupeKey,
        organizationId: request.organizationId ?? null,
        correlationId: request.correlationId ?? null,
      });
      return { kind: 'deferred' as const, attemptId, until: decision.deferUntil };
    }
    return { kind: 'send' as const, attemptId, message };
  });

  const recipientLabel = address ?? recipient.name;
  switch (prepared.kind) {
    case 'deduplicated':
      return {
        attemptId: prepared.prior?.id ?? null,
        channel,
        recipient: recipientLabel,
        status: 'deduplicated',
        reason: prepared.prior ? `existing:${prepared.prior.status}` : 'existing',
      };
    case 'settled':
      return { attemptId: prepared.attemptId, channel, recipient: recipientLabel, status: prepared.status, reason: prepared.reason };
    case 'deferred':
      return {
        attemptId: prepared.attemptId,
        channel,
        recipient: recipientLabel,
        status: 'queued',
        reason: 'quiet_hours',
        deferredUntil: prepared.until,
      };
    case 'send': {
      // Phase 2: provider I/O outside the transaction; phase 3: record the outcome.
      const outcome = await sendOutbound(prepared.message, dedupeKey, providers);
      await withActor(db, systemContext('notifications'), (tx) =>
        recordSendOutcome(tx, prepared.attemptId, outcome, env.now()),
      );
      if (outcome.status === 'failed') {
        env.log.warn(
          { attemptId: prepared.attemptId, channel, reason: outcome.errorSanitized, retryable: outcome.retryable },
          'notification send failed',
        );
      }
      return {
        attemptId: prepared.attemptId,
        channel,
        recipient: recipientLabel,
        status: outcome.retryable ? 'queued' : outcome.status,
        reason: outcome.errorSanitized,
        providerMessageId: outcome.providerMessageId,
        retryable: outcome.retryable,
      };
    }
  }
}

async function insertAttempt(
  tx: DbExecutor,
  input: {
    channel: NotificationChannel;
    category: NotificationRequest['category'];
    templateKey: string;
    templateVersion: number | null;
    recipient: string;
    userId: string | null;
    provider: string;
    environment: 'test' | 'live';
    dedupeKey: string;
    relatedEntityType: string | null;
    relatedEntityId: string | null;
    subject: string | null;
    segments: number | null;
    estimatedCostKobo: number | null;
    now: Date;
  },
): Promise<string | null> {
  const rows = await tx
    .insert(schema.deliveryAttempts)
    .values({
      channel: input.channel,
      category: input.category,
      templateKey: input.templateKey,
      templateVersion: input.templateVersion,
      recipient: input.recipient,
      userId: input.userId,
      provider: input.provider,
      environment: input.environment,
      status: 'queued',
      dedupeKey: input.dedupeKey,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      subject: input.subject,
      segments: input.segments,
      estimatedCostKobo: input.estimatedCostKobo === null ? null : BigInt(input.estimatedCostKobo),
      queuedAt: input.now,
    })
    .onConflictDoNothing({ target: schema.deliveryAttempts.dedupeKey })
    .returning({ id: schema.deliveryAttempts.id });
  return rows[0]?.id ?? null;
}
