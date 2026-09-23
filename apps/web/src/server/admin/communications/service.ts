import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiError,
  type CommunicationsTestSendInput,
  type CommunicationsTestSendResponse,
  type DeliveryLogItemDto,
  type DeliveryLogQuery,
  type SamplePreviewInput,
  type SamplePreviewResponse,
  type SuppressionListQuery,
  type TemplateCreate,
  type TemplateFamilyDetailDto,
  type TemplateFamilySummaryDto,
  type TemplateRestoreInput,
  type TemplateUpdate,
} from '@simplexd/contracts';
import { schema, systemContext, withActor } from '@simplexd/db';
import { hasStaffPermission } from '@simplexd/domain/authz';
import {
  NotificationAdminError,
  applyTemplateAction,
  createTemplate,
  getDeliveryLogItem,
  getTemplateFamily,
  listDeliveryLog,
  listSuppressions,
  listTemplateFamilies,
  previewWithSamples,
  processBounce,
  providerStatus,
  removeSuppression,
  restoreTemplateVersion,
  retryDeliveryAttempt,
  sampleVariablesFor,
  simulateDevelopmentReceipt,
  testSend,
  updateTemplate,
  type NotificationChannel,
  type PipelineOptions,
  type ProviderStatusDto,
  type TemplateAction,
  type TemplateDto,
} from '@simplexd/notifications';
import { env } from '@/lib/env';
import { actorId, authorize, type AdminContext } from '../context';

/**
 * Admin → Communications: template versions with server-side sample
 * previews, explicit test sends, the masked delivery log with retry, and the
 * suppression list. Every function checks its staff permission first
 * (`notifications.templates.manage`, `notifications.test_send`,
 * `integrations.read`); none of them is MFA-gated, so pages may call them
 * during render. Recipients are masked everywhere except the address an
 * operator typed for a test send.
 */

export interface CommunicationsAccess {
  templates: boolean;
  testSend: boolean;
  providers: boolean;
  any: boolean;
}

export function communicationsAccess(ctx: AdminContext): CommunicationsAccess {
  const actor = ctx.identity.actor;
  const templates = hasStaffPermission(actor, 'notifications.templates.manage');
  const testSend = hasStaffPermission(actor, 'notifications.test_send');
  const providers = hasStaffPermission(actor, 'integrations.read');
  return { templates, testSend, providers, any: templates || testSend };
}

/** Pipeline settings from the validated server env; tests may inject providers. */
export function communicationsPipeline(overrides: PipelineOptions = {}): PipelineOptions {
  const e = env();
  return { appEnv: e.APP_ENV, appUrl: e.APP_URL, brandName: e.APP_NAME, ...overrides };
}

function actorOf(ctx: AdminContext) {
  return { userId: actorId(ctx), correlationId: ctx.correlationId };
}

/** Maps the notification package's typed errors onto the API error contract. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotificationAdminError) {
      throw new ApiError(err.code, err.message, { details: err.details });
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------- */
/* Templates                                                               */
/* ---------------------------------------------------------------------- */

export async function listTemplateCatalog(
  ctx: AdminContext,
  filter: { channel?: NotificationChannel; search?: string } = {},
): Promise<TemplateFamilySummaryDto[]> {
  authorize(ctx, 'notifications.templates.manage');
  return listTemplateFamilies(ctx.db, filter);
}

export async function templateFamily(
  ctx: AdminContext,
  input: { key: string; channel: NotificationChannel; locale?: string },
  options: PipelineOptions = {},
): Promise<TemplateFamilyDetailDto> {
  authorize(ctx, 'notifications.templates.manage');
  const family = await getTemplateFamily(ctx.db, input, communicationsPipeline(options));
  if (!family) throw new ApiError('not_found', 'template not found');
  return family;
}

/** Saves edited content as the next version (draft). Earlier versions are never changed. */
export async function createTemplateVersion(
  ctx: AdminContext,
  input: TemplateCreate,
): Promise<TemplateDto> {
  authorize(ctx, 'notifications.templates.manage');
  return call(() => createTemplate(ctx.db, input, actorOf(ctx)));
}

/** Edits a draft in place (approved and retired versions are immutable). */
export async function updateTemplateDraft(
  ctx: AdminContext,
  id: string,
  input: TemplateUpdate,
): Promise<TemplateDto> {
  authorize(ctx, 'notifications.templates.manage');
  return call(() => updateTemplate(ctx.db, id, input, actorOf(ctx)));
}

/** approve (activate; retires the previous active version), retire, reopen. */
export async function changeTemplateStatus(
  ctx: AdminContext,
  id: string,
  action: TemplateAction,
): Promise<TemplateDto> {
  authorize(ctx, 'notifications.templates.manage');
  return call(() => applyTemplateAction(ctx.db, id, action, actorOf(ctx)));
}

/** Rollback: copies an older version into a new one (optionally activating it). */
export async function restoreTemplate(ctx: AdminContext, id: string, input: TemplateRestoreInput) {
  authorize(ctx, 'notifications.templates.manage');
  return call(() =>
    restoreTemplateVersion(
      ctx.db,
      id,
      { activate: input.activate, reason: input.reason ?? null },
      actorOf(ctx),
    ),
  );
}

/** Server-side preview with catalogue samples and optional staff overrides only. */
export async function previewTemplateWithSamples(
  ctx: AdminContext,
  input: SamplePreviewInput,
  options: PipelineOptions = {},
): Promise<SamplePreviewResponse> {
  authorize(ctx, 'notifications.templates.manage');
  return call(() =>
    previewWithSamples(
      ctx.db,
      {
        templateId: input.templateId,
        template: input.template,
        overrides: input.sampleVariables,
      },
      communicationsPipeline(options),
    ),
  );
}

/* ---------------------------------------------------------------------- */
/* Test send                                                               */
/* ---------------------------------------------------------------------- */

async function templateVariablesFor(
  ctx: AdminContext,
  key: string,
  channel: 'email' | 'sms',
): Promise<string[] | null> {
  const rows = await withActor(ctx.db, systemContext('test-send'), (tx) =>
    tx
      .select({ variables: schema.templates.variables, status: schema.templates.status })
      .from(schema.templates)
      .where(and(eq(schema.templates.key, key), eq(schema.templates.channel, channel)))
      .orderBy(desc(schema.templates.version)),
  );
  if (rows.length === 0) return null;
  const chosen = rows.find((r) => r.status === 'approved') ?? rows[0]!;
  return chosen.variables ?? [];
}

/**
 * Explicit test email/SMS to a staff-entered recipient. Templates other than
 * `test_message` render with sample values, never with customer data. The
 * response carries the provider's own answer (accepted or rejected, with the
 * sanitised reason) separately from later delivery status.
 */
export async function sendTestMessage(
  ctx: AdminContext,
  input: CommunicationsTestSendInput,
  options: PipelineOptions = {},
): Promise<CommunicationsTestSendResponse> {
  authorize(ctx, 'notifications.test_send');
  const pipeline = communicationsPipeline(options);
  let samples: ReturnType<typeof sampleVariablesFor> = [];
  if (input.templateKey) {
    const names = await templateVariablesFor(ctx, input.templateKey, input.channel);
    if (!names) {
      throw new ApiError(
        'validation_failed',
        `there is no ${input.channel} template "${input.templateKey}"`,
        { details: [{ path: 'templateKey', message: 'unknown template for this channel' }] },
      );
    }
    samples = sampleVariablesFor(names, pipeline, input.sampleVariables ?? {});
  }
  const result = await call(() =>
    testSend(
      ctx.db,
      {
        channel: input.channel,
        to: input.to,
        templateKey: input.templateKey,
        variables: Object.fromEntries(samples.map((s) => [s.name, s.value])),
      },
      actorOf(ctx),
      pipeline,
    ),
  );
  const attempt = result.outcome.attemptId
    ? await getDeliveryLogItem(ctx.db, result.outcome.attemptId)
    : null;
  const adapter = attempt?.provider ?? result.provider.adapter;
  return {
    to: result.outcome.recipient,
    outcome: {
      status: result.outcome.status,
      reason: result.outcome.reason,
      providerMessageId: result.outcome.providerMessageId ?? attempt?.providerMessageId ?? null,
    },
    provider: {
      adapter,
      environment: result.provider.environment,
      configured: result.provider.configured,
      developmentAdapter: adapter === 'dev',
      reason: result.provider.reason,
    },
    attempt,
    samples,
  };
}

/* ---------------------------------------------------------------------- */
/* Delivery log                                                            */
/* ---------------------------------------------------------------------- */

export async function deliveryLog(ctx: AdminContext, query: DeliveryLogQuery) {
  authorize(ctx, 'notifications.templates.manage');
  return listDeliveryLog(ctx.db, {
    channel: query.channel,
    status: query.status,
    templateKey: query.templateKey,
    recipient: query.recipient,
    testOnly: query.testOnly,
    developmentOnly: query.developmentOnly,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    cursor: query.cursor,
    limit: query.limit,
  });
}

/** One attempt; test senders may poll the attempt their own test created. */
export async function deliveryDetail(ctx: AdminContext, id: string): Promise<DeliveryLogItemDto> {
  const access = communicationsAccess(ctx);
  if (!access.templates) authorize(ctx, 'notifications.test_send');
  const item = await getDeliveryLogItem(ctx.db, id);
  if (!item) throw new ApiError('not_found', 'delivery attempt not found');
  // Without template/log access, only test attempts are visible.
  if (!access.templates && !item.isTest) throw new ApiError('not_found', 'delivery attempt not found');
  return item;
}

/** Idempotent: a repeated request returns the existing retry and sends nothing new. */
export async function retryDelivery(ctx: AdminContext, id: string, options: PipelineOptions = {}) {
  authorize(ctx, 'notifications.templates.manage');
  const result = await call(() =>
    retryDeliveryAttempt(ctx.db, id, actorOf(ctx), communicationsPipeline(options)),
  );
  return { created: result.created, original: result.original, retry: result.retry };
}

/** Development adapter only: feed a signed simulated receipt through the real webhook handler. */
export async function simulateReceipt(
  ctx: AdminContext,
  id: string,
  state: 'delivered' | 'failed' | 'rejected' | undefined,
  options: PipelineOptions = {},
) {
  authorize(ctx, 'notifications.test_send');
  const pipeline = communicationsPipeline(options);
  if (pipeline.appEnv === 'production') throw new ApiError('not_found', 'not available');
  const result = await call(() =>
    simulateDevelopmentReceipt(ctx.db, id, state, actorOf(ctx), pipeline),
  );
  return { action: result.webhook.action, attempt: result.attempt };
}

/* ---------------------------------------------------------------------- */
/* Suppressions and bounces                                                */
/* ---------------------------------------------------------------------- */

export async function suppressionList(ctx: AdminContext, query: SuppressionListQuery) {
  authorize(ctx, 'notifications.templates.manage');
  return listSuppressions(ctx.db, query);
}

/** Lifts a suppression with a reason recorded in the audit log. */
export async function liftSuppression(ctx: AdminContext, id: string, reason: string) {
  authorize(ctx, 'notifications.templates.manage');
  return call(() => removeSuppression(ctx.db, id, { reason }, actorOf(ctx)));
}

/** Manual bounce/complaint import (no SMTP feedback webhook is configured). */
export async function recordBounce(
  ctx: AdminContext,
  input: {
    email: string;
    kind: 'hard' | 'soft' | 'complaint';
    reason?: string | null;
    providerMessageId?: string | null;
  },
) {
  authorize(ctx, 'notifications.templates.manage');
  const result = await processBounce(
    ctx.db,
    {
      email: input.email,
      kind: input.kind,
      reason: input.reason ?? null,
      providerMessageId: input.providerMessageId ?? null,
      source: `manual:${actorId(ctx)}`,
    },
    communicationsPipeline(),
  );
  await withActor(ctx.db, systemContext(ctx.correlationId ?? 'bounce-import'), (tx) =>
    tx.insert(schema.auditEvents).values({
      actorType: 'user',
      actorUserId: actorId(ctx),
      action: 'notifications.bounce.recorded',
      entityType: 'delivery_attempt',
      entityId: result.attemptId,
      after: { kind: input.kind, suppressed: result.suppressed },
      correlationId: ctx.correlationId,
    }),
  );
  return result;
}

/* ---------------------------------------------------------------------- */
/* Providers                                                               */
/* ---------------------------------------------------------------------- */

export async function providerOverview(ctx: AdminContext): Promise<ProviderStatusDto[]> {
  authorize(ctx, 'integrations.read');
  return providerStatus(ctx.db, communicationsPipeline());
}
