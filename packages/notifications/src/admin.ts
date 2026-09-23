import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, ilike, lt, lte, max, or, sql } from 'drizzle-orm';
import { schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import { normalizeToE164, analyzeSegments } from '@simplexd/integrations/sms';
import { previewTemplate, renderEmail, templateVariables } from '@simplexd/integrations/templates';
import { dispatchRequest } from './dispatch';
import { EMAIL_FOOTER, resolveEnv } from './env';
import { resolveMailProvider, resolveSmsProvider } from './providers';
import type { AttemptOutcome, Db, DeliveryStatus, NotificationCategory, NotificationChannel, PipelineOptions } from './types';

/**
 * Admin operations: template lifecycle (draft → approved → retired) with
 * preview, explicit test sends that return the real provider result, the
 * delivery log and provider status. Callers check permissions
 * (`notifications.templates.manage`, `notifications.test_send`) before
 * calling; everything here runs as the system actor and audits with the
 * staff user id. No secret ever leaves these functions.
 */

export class NotificationAdminError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation_failed' | 'invalid_transition' | 'conflict',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'NotificationAdminError';
  }
}

type TemplateRow = typeof schema.templates.$inferSelect;

export interface TemplateDto {
  id: string;
  key: string;
  channel: NotificationChannel;
  locale: string;
  version: number;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  variables: string[];
  status: TemplateRow['status'];
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const templateToDto = (r: TemplateRow): TemplateDto => ({
  id: r.id,
  key: r.key,
  channel: r.channel,
  locale: r.locale,
  version: r.version,
  subject: r.subject,
  bodyText: r.bodyText,
  bodyHtml: r.bodyHtml,
  variables: r.variables ?? [],
  status: r.status,
  approvedBy: r.approvedBy,
  approvedAt: iso(r.approvedAt),
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function audit(
  tx: DbExecutor,
  actorUserId: string | null,
  action: string,
  entityId: string,
  after: unknown,
  before?: unknown,
  correlationId?: string | null,
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    actorType: actorUserId ? 'user' : 'system',
    actorUserId,
    action,
    entityType: 'template',
    entityId,
    before: before ?? null,
    after: after ?? null,
    correlationId: correlationId ?? null,
  });
}

export interface TemplateListFilter {
  key?: string;
  channel?: NotificationChannel;
  status?: TemplateRow['status'];
  locale?: string;
}

export async function listTemplates(db: Db, filter: TemplateListFilter = {}): Promise<TemplateDto[]> {
  return withActor(db, systemContext('templates'), async (tx) => {
    const rows = await tx
      .select()
      .from(schema.templates)
      .where(
        and(
          filter.key ? eq(schema.templates.key, filter.key) : undefined,
          filter.channel ? eq(schema.templates.channel, filter.channel) : undefined,
          filter.status ? eq(schema.templates.status, filter.status) : undefined,
          filter.locale ? eq(schema.templates.locale, filter.locale) : undefined,
        ),
      )
      .orderBy(schema.templates.key, schema.templates.channel, schema.templates.locale, desc(schema.templates.version));
    return rows.map(templateToDto);
  });
}

export async function getTemplate(db: Db, id: string): Promise<TemplateDto> {
  const [row] = await withActor(db, systemContext('templates'), (tx) =>
    tx.select().from(schema.templates).where(eq(schema.templates.id, id)),
  );
  if (!row) throw new NotificationAdminError('not_found', 'template not found');
  return templateToDto(row);
}

export interface TemplateCreateInput {
  key: string;
  channel: NotificationChannel;
  locale?: string;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
}

function validateContent(input: { channel: NotificationChannel; subject?: string | null; bodyText: string; bodyHtml?: string | null }): string[] {
  if (!input.bodyText.trim()) throw new NotificationAdminError('validation_failed', 'bodyText is required', [{ path: 'bodyText' }]);
  if (input.channel === 'email' && !input.subject?.trim())
    throw new NotificationAdminError('validation_failed', 'email templates need a subject', [{ path: 'subject' }]);
  if (input.channel === 'sms') {
    if (input.bodyHtml) throw new NotificationAdminError('validation_failed', 'SMS templates have no HTML body', [{ path: 'bodyHtml' }]);
    const estimate = analyzeSegments(input.bodyText);
    if (estimate.segments > 5)
      throw new NotificationAdminError('validation_failed', `SMS body would need ${estimate.segments} segments; keep it to 5 or fewer`, [{ path: 'bodyText' }]);
  }
  return templateVariables({ subject: input.subject ?? null, bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null });
}

/** New draft version for a key/channel/locale (next version number). */
export async function createTemplate(
  db: Db,
  input: TemplateCreateInput,
  actor: { userId: string; correlationId?: string | null },
): Promise<TemplateDto> {
  const locale = input.locale ?? 'en';
  const variables = validateContent(input);
  return withActor(db, systemContext('templates'), async (tx) => {
    const [latest] = await tx
      .select({ version: max(schema.templates.version) })
      .from(schema.templates)
      .where(and(eq(schema.templates.key, input.key), eq(schema.templates.channel, input.channel), eq(schema.templates.locale, locale)));
    const [row] = await tx
      .insert(schema.templates)
      .values({
        key: input.key,
        channel: input.channel,
        locale,
        version: (latest?.version ?? 0) + 1,
        subject: input.subject ?? null,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        variables,
        status: 'draft',
        createdBy: actor.userId,
      })
      .returning();
    await audit(tx, actor.userId, 'template.created', row!.id, { key: row!.key, channel: row!.channel, version: row!.version }, undefined, actor.correlationId);
    return templateToDto(row!);
  });
}

export interface TemplateUpdateInput {
  subject?: string | null;
  bodyText?: string;
  bodyHtml?: string | null;
  expectedUpdatedAt?: string;
}

/** Drafts are editable; approved and retired versions are immutable (create a new version instead). */
export async function updateTemplate(
  db: Db,
  id: string,
  input: TemplateUpdateInput,
  actor: { userId: string; correlationId?: string | null },
): Promise<TemplateDto> {
  return withActor(db, systemContext('templates'), async (tx) => {
    const [current] = await tx.select().from(schema.templates).where(eq(schema.templates.id, id));
    if (!current) throw new NotificationAdminError('not_found', 'template not found');
    if (current.status !== 'draft')
      throw new NotificationAdminError('invalid_transition', `an ${current.status} template is immutable; create a new version`);
    if (input.expectedUpdatedAt && Math.abs(new Date(input.expectedUpdatedAt).getTime() - current.updatedAt.getTime()) > 999)
      throw new NotificationAdminError('conflict', 'template changed since you loaded it', { currentUpdatedAt: current.updatedAt.toISOString() });
    const next = {
      channel: current.channel,
      subject: input.subject === undefined ? current.subject : input.subject,
      bodyText: input.bodyText ?? current.bodyText,
      bodyHtml: input.bodyHtml === undefined ? current.bodyHtml : input.bodyHtml,
    };
    const variables = validateContent(next);
    const [row] = await tx
      .update(schema.templates)
      .set({ subject: next.subject, bodyText: next.bodyText, bodyHtml: next.bodyHtml, variables })
      .where(eq(schema.templates.id, id))
      .returning();
    await audit(tx, actor.userId, 'template.updated', id, { variables }, { variables: current.variables }, actor.correlationId);
    return templateToDto(row!);
  });
}

export type TemplateAction = 'approve' | 'retire' | 'reopen';

/**
 * Lifecycle: draft → approved (approver recorded, older approved versions of
 * the same key/channel/locale are retired so exactly one version sends),
 * approved → retired, retired → draft (reopen for edits).
 */
export async function applyTemplateAction(
  db: Db,
  id: string,
  action: TemplateAction,
  actor: { userId: string; correlationId?: string | null },
): Promise<TemplateDto> {
  return withActor(db, systemContext('templates'), async (tx) => {
    const [current] = await tx.select().from(schema.templates).where(eq(schema.templates.id, id));
    if (!current) throw new NotificationAdminError('not_found', 'template not found');
    let patch: Partial<TemplateRow>;
    switch (action) {
      case 'approve':
        if (current.status !== 'draft') throw new NotificationAdminError('invalid_transition', 'only drafts can be approved');
        validateContent(current);
        patch = { status: 'approved', approvedBy: actor.userId, approvedAt: new Date() };
        await tx
          .update(schema.templates)
          .set({ status: 'retired' })
          .where(
            and(
              eq(schema.templates.key, current.key),
              eq(schema.templates.channel, current.channel),
              eq(schema.templates.locale, current.locale),
              eq(schema.templates.status, 'approved'),
            ),
          );
        break;
      case 'retire':
        if (current.status === 'retired') throw new NotificationAdminError('invalid_transition', 'template is already retired');
        patch = { status: 'retired' };
        break;
      case 'reopen':
        if (current.status !== 'retired') throw new NotificationAdminError('invalid_transition', 'only retired templates can be reopened as drafts');
        patch = { status: 'draft', approvedBy: null, approvedAt: null };
        break;
    }
    const [row] = await tx.update(schema.templates).set(patch).where(eq(schema.templates.id, id)).returning();
    await audit(tx, actor.userId, `template.${action}`, id, { status: row!.status }, { status: current.status }, actor.correlationId);
    return templateToDto(row!);
  });
}

export interface PreviewInput {
  templateId?: string;
  template?: { channel: NotificationChannel; subject?: string | null; bodyText: string; bodyHtml?: string | null };
  sampleVariables?: Record<string, string | number>;
}

export interface PreviewResult {
  channel: NotificationChannel;
  subject: string | null;
  text: string;
  html: string | null;
  variables: string[];
  missing: string[];
  sms: { segments: number; encoding: string; characters: number } | null;
}

export async function previewNotificationTemplate(db: Db, input: PreviewInput, options: PipelineOptions = {}): Promise<PreviewResult> {
  const env = resolveEnv(options);
  let source = input.template ?? null;
  if (input.templateId) {
    const row = await getTemplate(db, input.templateId);
    source = { channel: row.channel, subject: row.subject, bodyText: row.bodyText, bodyHtml: row.bodyHtml };
  }
  if (!source) throw new NotificationAdminError('validation_failed', 'templateId or template is required');
  const sample = input.sampleVariables ?? {};
  const preview = previewTemplate(source, sample);
  const filled: Record<string, string | number> = { ...sample };
  for (const name of preview.missing) filled[name] = `[${name}]`;
  const html =
    source.channel === 'email'
      ? renderEmail(source, filled, { brandName: env.brandName, appUrl: env.appUrl, footerNote: EMAIL_FOOTER }).html
      : preview.html;
  const segments = source.channel === 'sms' ? analyzeSegments(preview.text) : null;
  return {
    channel: source.channel,
    subject: preview.subject,
    text: preview.text,
    html,
    variables: preview.variables,
    missing: preview.missing,
    sms: segments ? { segments: segments.segments, encoding: segments.encoding, characters: segments.characters } : null,
  };
}

export interface TestSendInput {
  channel: 'email' | 'sms';
  /** Staff-entered address or phone; always shown to the operator before sending. */
  to: string;
  templateKey?: string;
  variables?: Record<string, string | number>;
}

export interface TestSendResult {
  outcome: AttemptOutcome;
  attempt: DeliveryDto | null;
  provider: { adapter: string; environment: string; configured: boolean; reason: string | null };
}

/** Explicit, permission-controlled test send that records a labelled attempt and returns the provider's real answer. */
export async function testSend(
  db: Db,
  input: TestSendInput,
  actor: { userId: string; correlationId?: string | null },
  options: PipelineOptions = {},
): Promise<TestSendResult> {
  const env = resolveEnv(options);
  let recipient: { email?: string; phone?: string };
  if (input.channel === 'sms') {
    const phone = normalizeToE164(input.to);
    if (!phone.ok) throw new NotificationAdminError('validation_failed', `invalid phone number (${phone.reason})`, [{ path: 'to' }]);
    recipient = { phone: phone.e164 };
  } else {
    const email = input.to.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new NotificationAdminError('validation_failed', 'invalid email address', [{ path: 'to' }]);
    recipient = { email };
  }
  const providerInfo =
    input.channel === 'sms' ? await resolveSmsProvider(db, env) : await resolveMailProvider(db, env);
  const result = await dispatchRequest(
    db,
    {
      templateKey: input.templateKey ?? 'test_message',
      category: 'transactional',
      channels: [input.channel],
      recipients: [{ ...recipient, name: 'Test recipient' }],
      variables: { environment: env.appEnv, sentAt: env.now().toISOString(), ...(input.variables ?? {}) },
      dedupeScope: `test:${randomUUID()}`,
      label: 'test',
      ignorePreferences: true,
      relatedEntity: { type: 'test_send', id: null },
      correlationId: actor.correlationId ?? null,
    },
    options,
  );
  const outcome = result.outcomes[0] ?? {
    attemptId: null,
    channel: input.channel,
    recipient: input.to,
    status: 'skipped' as const,
    reason: 'no recipient resolved',
  };
  await withActor(db, systemContext('test-send'), (tx) =>
    tx.insert(schema.auditEvents).values({
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'notifications.test_send',
      entityType: 'delivery_attempt',
      entityId: outcome.attemptId,
      after: { channel: input.channel, recipient: input.to, status: outcome.status, reason: outcome.reason },
      correlationId: actor.correlationId ?? null,
    }),
  );
  const attempt = outcome.attemptId ? await getDelivery(db, outcome.attemptId) : null;
  return {
    outcome,
    attempt,
    provider: {
      adapter: providerInfo.adapter,
      environment: providerInfo.environment,
      configured: providerInfo.provider !== null,
      reason: providerInfo.reason,
    },
  };
}

type AttemptRow = typeof schema.deliveryAttempts.$inferSelect;

export interface DeliveryDto {
  id: string;
  channel: NotificationChannel;
  category: NotificationCategory;
  templateKey: string | null;
  templateVersion: number | null;
  recipient: string;
  userId: string | null;
  provider: string;
  environment: string;
  status: DeliveryStatus;
  providerMessageId: string | null;
  providerStatus: string | null;
  errorSanitized: string | null;
  segments: number | null;
  estimatedCostKobo: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  subject: string | null;
  isTest: boolean;
  attempts: number;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

const deliveryToDto = (r: AttemptRow): DeliveryDto => ({
  id: r.id,
  channel: r.channel,
  category: r.category,
  templateKey: r.templateKey,
  templateVersion: r.templateVersion,
  recipient: r.recipient,
  userId: r.userId,
  provider: r.provider,
  environment: r.environment,
  status: r.status,
  providerMessageId: r.providerMessageId,
  providerStatus: r.providerStatus,
  errorSanitized: r.errorSanitized,
  segments: r.segments,
  estimatedCostKobo: r.estimatedCostKobo === null ? null : r.estimatedCostKobo.toString(),
  relatedEntityType: r.relatedEntityType,
  relatedEntityId: r.relatedEntityId,
  subject: r.subject,
  isTest: r.relatedEntityType === 'test_send',
  attempts: r.attempts,
  queuedAt: r.queuedAt.toISOString(),
  sentAt: iso(r.sentAt),
  deliveredAt: iso(r.deliveredAt),
  failedAt: iso(r.failedAt),
  createdAt: r.createdAt.toISOString(),
});

export async function getDelivery(db: Db, id: string): Promise<DeliveryDto | null> {
  const [row] = await withActor(db, systemContext('deliveries'), (tx) =>
    tx.select().from(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.id, id)),
  );
  return row ? deliveryToDto(row) : null;
}

export interface DeliveryListQuery {
  channel?: NotificationChannel;
  status?: DeliveryStatus;
  templateKey?: string;
  recipient?: string;
  userId?: string;
  provider?: string;
  testOnly?: boolean;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface DeliveryPage {
  items: DeliveryDto[];
  nextCursor: string | null;
}

export async function listDeliveries(db: Db, query: DeliveryListQuery = {}): Promise<DeliveryPage> {
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  let cursor: { createdAt: Date; id: string } | null = null;
  if (query.cursor) {
    const [isoAt, id] = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|');
    if (isoAt && id && !Number.isNaN(new Date(isoAt).getTime())) cursor = { createdAt: new Date(isoAt), id };
  }
  return withActor(db, systemContext('deliveries'), async (tx) => {
    const rows = await tx
      .select()
      .from(schema.deliveryAttempts)
      .where(
        and(
          query.channel ? eq(schema.deliveryAttempts.channel, query.channel) : undefined,
          query.status ? eq(schema.deliveryAttempts.status, query.status) : undefined,
          query.templateKey ? eq(schema.deliveryAttempts.templateKey, query.templateKey) : undefined,
          query.recipient ? ilike(schema.deliveryAttempts.recipient, `%${query.recipient.replace(/[%_]/g, '')}%`) : undefined,
          query.userId ? eq(schema.deliveryAttempts.userId, query.userId) : undefined,
          query.provider ? eq(schema.deliveryAttempts.provider, query.provider) : undefined,
          query.testOnly ? eq(schema.deliveryAttempts.relatedEntityType, 'test_send') : undefined,
          query.from ? gte(schema.deliveryAttempts.createdAt, query.from) : undefined,
          query.to ? lte(schema.deliveryAttempts.createdAt, query.to) : undefined,
          cursor
            ? or(
                lt(schema.deliveryAttempts.createdAt, cursor.createdAt),
                and(eq(schema.deliveryAttempts.createdAt, cursor.createdAt), lt(schema.deliveryAttempts.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.deliveryAttempts.createdAt), desc(schema.deliveryAttempts.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(deliveryToDto),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString('base64url')
          : null,
    };
  });
}

export interface ProviderStatusDto {
  provider: 'smtp' | 'termii';
  channel: 'email' | 'sms';
  environment: 'test' | 'live';
  /** Admin-recorded state; `disconnected` when nothing is configured. */
  status: 'disconnected' | 'configured_unverified' | 'connected' | 'degraded' | 'expired' | 'disabled';
  adapter: string;
  enabled: boolean;
  configured: boolean;
  /** True when the labelled development adapter would handle sends. */
  devFallback: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  lastSuccessAt: string | null;
  activatedAt: string | null;
  credentialRotatedAt: string | null;
  /** Aggregate delivery counts for the last 24 hours. */
  last24h: Record<string, number>;
}

/** Provider summary for the admin dashboard. Never includes settings or secrets. */
export async function providerStatus(db: Db, options: PipelineOptions = {}): Promise<ProviderStatusDto[]> {
  const env = resolveEnv(options);
  const environment: 'test' | 'live' = env.production ? 'live' : 'test';
  const since = new Date(env.now().getTime() - 24 * 60 * 60_000);
  return withActor(db, systemContext('provider-status'), async (tx) => {
    const out: ProviderStatusDto[] = [];
    for (const provider of ['smtp', 'termii'] as const) {
      const [config] = await tx
        .select()
        .from(schema.integrationConfigs)
        .where(
          and(
            eq(schema.integrationConfigs.provider, provider),
            eq(schema.integrationConfigs.environment, environment),
            eq(schema.integrationConfigs.isActive, true),
          ),
        );
      const channel = provider === 'smtp' ? 'email' : 'sms';
      const counts = await tx
        .select({ status: schema.deliveryAttempts.status, n: sql<string>`count(*)::text` })
        .from(schema.deliveryAttempts)
        .where(and(eq(schema.deliveryAttempts.channel, channel), gte(schema.deliveryAttempts.createdAt, since)))
        .groupBy(schema.deliveryAttempts.status);
      const configured = Boolean(config && config.enabled && config.adapter !== 'dev');
      out.push({
        provider,
        channel,
        environment,
        status: config?.status ?? 'disconnected',
        adapter: configured ? config!.adapter : env.production ? 'none' : 'dev',
        enabled: config?.enabled ?? false,
        configured,
        devFallback: !configured && !env.production,
        lastCheckAt: iso(config?.lastCheckAt),
        lastCheckOk: config?.lastCheckOk ?? null,
        lastCheckMessage: config?.lastCheckMessage ?? null,
        lastSuccessAt: iso(config?.lastSuccessAt),
        activatedAt: iso(config?.activatedAt),
        credentialRotatedAt: iso(config?.credentialRotatedAt),
        last24h: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      });
    }
    return out;
  });
}
