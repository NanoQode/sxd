import { and, desc, eq, gte, inArray, like, lt, lte, max, or, sql, type SQL } from 'drizzle-orm';
import { schema, systemContext, withActor, type DbExecutor } from '@simplexd/db';
import {
  DevSmsProvider,
  analyzeSegments,
  detectEncoding,
  normalizeToE164,
} from '@simplexd/integrations/sms';
import type { TemplateVariables } from '@simplexd/integrations/templates';
import {
  NotificationAdminError,
  previewNotificationTemplate,
  templateToDto,
  type TemplateDto,
} from './admin';
import { dispatchRequest } from './dispatch';
import { resolveEnv, type PipelineEnv } from './env';
import { processTermiiWebhook, type WebhookOutcome } from './inbound';
import { getDevSmsProvider } from './providers';
import { resolveOutboxEventRequests } from './registry';
import type {
  AttemptOutcome,
  Db,
  DeliveryStatus,
  NotificationCategory,
  NotificationChannel,
  NotificationRequest,
  PipelineOptions,
  RecipientSpec,
} from './types';

/**
 * Communications administration (brief §13/§14, acceptance scenario 8):
 *
 * - previews render against a fixed catalogue of obviously fake sample
 *   values (plus optional staff overrides) and never read customer records;
 * - rollback copies an older version into a new version, so history is never
 *   rewritten;
 * - the delivery log masks recipients and derives a status timeline from the
 *   attempt timestamps; acceptance by a provider is never shown as delivery;
 * - retry of a failed attempt creates one linked attempt (`retry:<id>` scope),
 *   so repeating the request never sends twice;
 * - lifting a suppression requires a reason and is audited.
 *
 * Callers check permissions first; everything here runs as the system actor
 * and audits with the staff user id.
 */

type AttemptRow = typeof schema.deliveryAttempts.$inferSelect;
type SuppressionRow = typeof schema.suppressions.$inferSelect;

export interface CommunicationsActor {
  userId: string;
  correlationId?: string | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

async function audit(
  tx: DbExecutor,
  actor: CommunicationsActor,
  input: {
    action: string;
    entityType: string;
    entityId: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    actorType: 'user',
    actorUserId: actor.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

/* ---------------------------------------------------------------------- */
/* Masking                                                                 */
/* ---------------------------------------------------------------------- */

/** `ada.obi@example.com` → `a•••i@example.com`; `+2348012345678` → `+234 ••• ••• 5678`. */
export function maskAddress(channel: NotificationChannel | string, value: string): string {
  const v = value.trim();
  if (channel === 'email' || v.includes('@')) {
    const at = v.lastIndexOf('@');
    if (at <= 0) return '•••';
    const local = v.slice(0, at);
    const domain = v.slice(at + 1);
    const shown =
      local.length <= 2 ? local.slice(0, 1) : `${local[0]}•••${local[local.length - 1]}`;
    return `${shown}${local.length <= 2 ? '•••' : ''}@${domain}`;
  }
  if (channel === 'sms' || /^\+?\d[\d\s-]{6,}$/.test(v)) {
    const digits = v.replace(/[^\d+]/g, '');
    if (digits.length < 8) return '•••';
    return `${digits.slice(0, 4)} ••• ••• ${digits.slice(-4)}`;
  }
  // In-app recipients are user ids, which are not contact details.
  return v;
}

/** Normalises a staff-entered lookup value to the stored form (E.164 / lowercase email). */
export function normalizeLookupAddress(
  value: string,
): { channel: 'email' | 'sms'; address: string } | null {
  const v = value.trim();
  if (!v) return null;
  if (v.includes('@')) return { channel: 'email', address: v.toLowerCase() };
  const phone = normalizeToE164(v);
  return phone.ok ? { channel: 'sms', address: phone.e164 } : null;
}

/* ---------------------------------------------------------------------- */
/* Sample variables                                                        */
/* ---------------------------------------------------------------------- */

export interface SampleVariable {
  name: string;
  value: string;
  description: string;
  /** `catalogue` = curated sample, `derived` = generated from the name, `override` = staff input. */
  source: 'catalogue' | 'derived' | 'override';
}

const SAMPLE_CATALOGUE: Record<string, { value: string; description: string }> = {
  name: { value: 'Ada Sample', description: 'Recipient display name' },
  contactName: { value: 'Ada Sample', description: 'Lead or contact name' },
  invitedBy: { value: 'Tunde Staff (sample)', description: 'Staff member who sent the invite' },
  amount: { value: '₦150,000.00', description: 'Formatted naira amount' },
  invoiceNumber: { value: 'INV-SAMPLE-0001', description: 'Invoice number' },
  receiptNumber: { value: 'RCT-SAMPLE-0001', description: 'Receipt number' },
  reference: { value: 'SR-SAMPLE-0001', description: 'Request or quote reference' },
  version: { value: '2', description: 'Quote version number' },
  code: { value: '123456', description: 'One-time code (sample; real codes are never stored)' },
  expiresIn: { value: '10 minutes', description: 'Time until a code or link expires' },
  kind: { value: 'site visit', description: 'Appointment kind' },
  change: { value: 'rescheduled', description: 'What changed about a booking' },
  customerTimeZone: { value: 'Africa/Lagos', description: 'Customer time zone' },
  businessTimeZone: { value: 'Africa/Lagos', description: 'Business time zone' },
  reportTitle: { value: 'Sample due diligence report', description: 'Report title' },
  subject: { value: 'Sample decision needed', description: 'Decision or conversation subject' },
  title: { value: 'Sample update', description: 'Headline of an activity update' },
  message: { value: 'This is sample text for the preview.', description: 'Update text' },
  statusLabel: { value: 'in progress', description: 'Human-readable status' },
  serviceName: { value: 'Due diligence', description: 'Service name' },
  source: { value: 'website', description: 'Lead source' },
  tenderTitle: { value: 'Sample tender', description: 'Tender title' },
  projectName: { value: 'Sample project', description: 'Project name' },
  period: { value: 'daily', description: 'Digest period' },
  count: { value: '3', description: 'Number of items' },
  items: {
    value: '• Sample item one\n• Sample item two\n• Sample item three',
    description: 'Digest item list',
  },
};

const SAMPLE_WHEN = 'Thu 1 Oct 2026, 10:00';
const SAMPLE_DAY = 'Thu 1 Oct 2026';

function derivedSample(name: string, env: PipelineEnv): { value: string; description: string } {
  if (name === 'environment') return { value: env.appEnv, description: 'Runtime environment' };
  if (name === 'sentAt') return { value: env.now().toISOString(), description: 'Send time' };
  if (name === 'appUrl') return { value: env.appUrl, description: 'Application URL' };
  if (/Url$/.test(name)) {
    const slug = name
      .replace(/Url$/, '')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
    return { value: `${env.appUrl}/sample/${slug || 'link'}`, description: 'Link (sample)' };
  }
  if (/(At|Customer|Business)$/.test(name) || /^startsAt/.test(name))
    return { value: SAMPLE_WHEN, description: 'Date and time' };
  if (/(date|Date|deadline|Deadline|dueAt)/.test(name))
    return { value: SAMPLE_DAY, description: 'Date' };
  if (/Number$/.test(name)) return { value: 'SAMPLE-0001', description: 'Reference number' };
  if (/Name$/.test(name)) return { value: 'Sample name', description: 'Name' };
  return { value: `sample ${name}`, description: 'No curated sample; generated from the name' };
}

/**
 * Sample values for template variables. Values come from a fixed catalogue
 * or are generated from the variable name; nothing is read from the
 * database, so previews and template test sends never contain customer data.
 */
export function sampleVariablesFor(
  names: readonly string[],
  options: PipelineOptions = {},
  overrides: TemplateVariables = {},
): SampleVariable[] {
  const env = resolveEnv(options);
  return names.map((name) => {
    const override = overrides[name];
    const known = SAMPLE_CATALOGUE[name];
    const base = known ?? derivedSample(name, env);
    if (override !== undefined && String(override).length > 0) {
      return { name, value: String(override), description: base.description, source: 'override' };
    }
    return {
      name,
      value: base.value,
      description: base.description,
      source: known ? 'catalogue' : 'derived',
    };
  });
}

function samplesToVariables(samples: SampleVariable[]): TemplateVariables {
  return Object.fromEntries(samples.map((s) => [s.name, s.value]));
}

/* ---------------------------------------------------------------------- */
/* SMS pricing and preview                                                 */
/* ---------------------------------------------------------------------- */

export const DEFAULT_SMS_UNIT_COST_KOBO = 400;

export interface SmsPricing {
  unitCostKobo: number;
  /** `termii_settings` when an active Termii configuration sets the price; otherwise the default. */
  source: 'termii_settings' | 'default';
  dailySpendCapKobo: number | null;
}

/** Per-segment price from the active Termii configuration (settings only; no secret is read). */
export async function smsPricing(db: Db, options: PipelineOptions = {}): Promise<SmsPricing> {
  const env = resolveEnv(options);
  const environment = env.production ? 'live' : 'test';
  const [config] = await withActor(db, systemContext('sms-pricing'), (tx) =>
    tx
      .select({
        settings: schema.integrationConfigs.settings,
        adapter: schema.integrationConfigs.adapter,
        enabled: schema.integrationConfigs.enabled,
      })
      .from(schema.integrationConfigs)
      .where(
        and(
          eq(schema.integrationConfigs.provider, 'termii'),
          eq(schema.integrationConfigs.environment, environment),
          eq(schema.integrationConfigs.isActive, true),
        ),
      ),
  );
  const settings = (config?.settings ?? {}) as Record<string, unknown>;
  const unit = settings['unitCostKobo'];
  const cap = settings['dailySpendCapKobo'];
  const real = Boolean(config && config.enabled && config.adapter !== 'dev');
  return {
    unitCostKobo:
      real && typeof unit === 'number' && unit >= 0 ? Math.round(unit) : DEFAULT_SMS_UNIT_COST_KOBO,
    source: real && typeof unit === 'number' ? 'termii_settings' : 'default',
    dailySpendCapKobo: real && typeof cap === 'number' ? cap : null,
  };
}

export interface SmsEstimate {
  segments: number;
  encoding: 'gsm7' | 'ucs2';
  characters: number;
  units: number;
  unitsPerSegment: number;
  remainingInSegment: number;
  /** Characters that force Unicode (UCS-2), each listed once. */
  unicodeCharacters: string[];
  unitCostKobo: number;
  unitCostSource: SmsPricing['source'];
  estimatedCostKobo: number;
}

export function estimateSms(body: string, pricing: SmsPricing): SmsEstimate {
  const analysis = analyzeSegments(body);
  const unicode: string[] = [];
  if (analysis.encoding === 'ucs2') {
    for (const ch of body) {
      if (detectEncoding(ch) === 'ucs2' && !unicode.includes(ch)) unicode.push(ch);
      if (unicode.length >= 20) break;
    }
  }
  return {
    segments: analysis.segments,
    encoding: analysis.encoding,
    characters: analysis.characters,
    units: analysis.units,
    unitsPerSegment: analysis.unitsPerSegment,
    remainingInSegment: analysis.remainingInSegment,
    unicodeCharacters: unicode,
    unitCostKobo: pricing.unitCostKobo,
    unitCostSource: pricing.source,
    estimatedCostKobo: analysis.segments * pricing.unitCostKobo,
  };
}

export interface SamplePreviewInput {
  templateId?: string;
  template?: {
    channel: NotificationChannel;
    subject?: string | null;
    bodyText: string;
    bodyHtml?: string | null;
  };
  /** Optional staff-typed sample values; never looked up from records. */
  overrides?: TemplateVariables;
}

export interface SamplePreviewResult {
  channel: NotificationChannel;
  subject: string | null;
  text: string;
  html: string | null;
  variables: string[];
  missing: string[];
  samples: SampleVariable[];
  sms: SmsEstimate | null;
}

/** Server-side preview with sample data only (no recipient, no business record). */
export async function previewWithSamples(
  db: Db,
  input: SamplePreviewInput,
  options: PipelineOptions = {},
): Promise<SamplePreviewResult> {
  // First pass finds the variable names; the second renders with the samples.
  const names = await previewNotificationTemplate(
    db,
    { templateId: input.templateId, template: input.template, sampleVariables: {} },
    options,
  );
  const samples = sampleVariablesFor(names.variables, options, input.overrides ?? {});
  const preview = await previewNotificationTemplate(
    db,
    {
      templateId: input.templateId,
      template: input.template,
      sampleVariables: samplesToVariables(samples),
    },
    options,
  );
  const sms =
    preview.channel === 'sms' ? estimateSms(preview.text, await smsPricing(db, options)) : null;
  return {
    channel: preview.channel,
    subject: preview.subject,
    text: preview.text,
    html: preview.html,
    variables: preview.variables,
    missing: preview.missing,
    samples,
    sms,
  };
}

/* ---------------------------------------------------------------------- */
/* Template families, history and rollback                                 */
/* ---------------------------------------------------------------------- */

export interface TemplateFamilySummary {
  key: string;
  channel: NotificationChannel;
  locale: string;
  activeVersion: number | null;
  activeId: string | null;
  activeApprovedAt: string | null;
  latestVersion: number;
  latestId: string;
  latestStatus: TemplateDto['status'];
  draftCount: number;
  versionCount: number;
  updatedAt: string;
}

export async function listTemplateFamilies(
  db: Db,
  filter: { channel?: NotificationChannel; search?: string } = {},
): Promise<TemplateFamilySummary[]> {
  const rows = await withActor(db, systemContext('templates'), (tx) =>
    tx
      .select()
      .from(schema.templates)
      .where(filter.channel ? eq(schema.templates.channel, filter.channel) : undefined)
      .orderBy(
        schema.templates.key,
        schema.templates.channel,
        schema.templates.locale,
        desc(schema.templates.version),
      ),
  );
  const search = filter.search?.trim().toLowerCase() ?? '';
  const families = new Map<string, TemplateFamilySummary>();
  for (const r of rows) {
    if (search && !r.key.includes(search)) continue;
    const id = `${r.key}|${r.channel}|${r.locale}`;
    let family = families.get(id);
    if (!family) {
      // Rows arrive newest version first.
      family = {
        key: r.key,
        channel: r.channel,
        locale: r.locale,
        activeVersion: null,
        activeId: null,
        activeApprovedAt: null,
        latestVersion: r.version,
        latestId: r.id,
        latestStatus: r.status,
        draftCount: 0,
        versionCount: 0,
        updatedAt: r.updatedAt.toISOString(),
      };
      families.set(id, family);
    }
    family.versionCount += 1;
    if (r.status === 'draft') family.draftCount += 1;
    if (r.status === 'approved' && family.activeVersion === null) {
      family.activeVersion = r.version;
      family.activeId = r.id;
      family.activeApprovedAt = iso(r.approvedAt);
    }
    if (r.updatedAt.toISOString() > family.updatedAt) family.updatedAt = r.updatedAt.toISOString();
  }
  return [...families.values()];
}

export interface TemplateFamilyDetail {
  key: string;
  channel: NotificationChannel;
  locale: string;
  /** Newest first; every version is kept. */
  versions: TemplateDto[];
  active: TemplateDto | null;
  variables: SampleVariable[];
  sms: SmsPricing | null;
}

export async function getTemplateFamily(
  db: Db,
  input: { key: string; channel: NotificationChannel; locale?: string },
  options: PipelineOptions = {},
): Promise<TemplateFamilyDetail | null> {
  const locale = input.locale ?? 'en';
  const rows = await withActor(db, systemContext('templates'), (tx) =>
    tx
      .select()
      .from(schema.templates)
      .where(
        and(
          eq(schema.templates.key, input.key),
          eq(schema.templates.channel, input.channel),
          eq(schema.templates.locale, locale),
        ),
      )
      .orderBy(desc(schema.templates.version)),
  );
  if (rows.length === 0) return null;
  const versions = rows.map(templateToDto);
  const active = versions.find((v) => v.status === 'approved') ?? null;
  const names: string[] = [];
  for (const v of [active, versions[0]])
    for (const n of v?.variables ?? []) if (!names.includes(n)) names.push(n);
  return {
    key: input.key,
    channel: input.channel,
    locale,
    versions,
    active,
    variables: sampleVariablesFor(names, options),
    sms: input.channel === 'sms' ? await smsPricing(db, options) : null,
  };
}

/**
 * Rollback without rewriting history: copies the content of `id` into a new
 * version (next number). With `activate`, the copy is approved in the same
 * transaction and the previously approved version is retired.
 */
export async function restoreTemplateVersion(
  db: Db,
  id: string,
  input: { activate: boolean; reason?: string | null },
  actor: CommunicationsActor,
): Promise<{ template: TemplateDto; restoredFrom: number; previousActiveVersion: number | null }> {
  return withActor(db, systemContext(actor.correlationId ?? 'templates'), async (tx) => {
    const [source] = await tx.select().from(schema.templates).where(eq(schema.templates.id, id));
    if (!source) throw new NotificationAdminError('not_found', 'template not found');
    const family = and(
      eq(schema.templates.key, source.key),
      eq(schema.templates.channel, source.channel),
      eq(schema.templates.locale, source.locale),
    );
    // Serialise version numbering for this family.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`template:${source.key}:${source.channel}:${source.locale}`}))`,
    );
    const [latest] = await tx
      .select({ version: max(schema.templates.version) })
      .from(schema.templates)
      .where(family);
    const [previousActive] = await tx
      .select({ id: schema.templates.id, version: schema.templates.version })
      .from(schema.templates)
      .where(and(family, eq(schema.templates.status, 'approved')));
    const now = new Date();
    if (input.activate) {
      await tx
        .update(schema.templates)
        .set({ status: 'retired' })
        .where(and(family, eq(schema.templates.status, 'approved')));
    }
    const [row] = await tx
      .insert(schema.templates)
      .values({
        key: source.key,
        channel: source.channel,
        locale: source.locale,
        version: (latest?.version ?? source.version) + 1,
        subject: source.subject,
        bodyText: source.bodyText,
        bodyHtml: source.bodyHtml,
        variables: source.variables ?? [],
        status: input.activate ? 'approved' : 'draft',
        approvedBy: input.activate ? actor.userId : null,
        approvedAt: input.activate ? now : null,
        createdBy: actor.userId,
      })
      .returning();
    await audit(tx, actor, {
      action: input.activate ? 'template.rollback' : 'template.restored',
      entityType: 'template',
      entityId: row!.id,
      before: { activeVersion: previousActive?.version ?? null },
      after: {
        key: row!.key,
        channel: row!.channel,
        locale: row!.locale,
        version: row!.version,
        restoredFrom: source.version,
        status: row!.status,
      },
      reason: input.reason ?? null,
    });
    return {
      template: templateToDto(row!),
      restoredFrom: source.version,
      previousActiveVersion: previousActive?.version ?? null,
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Delivery log                                                            */
/* ---------------------------------------------------------------------- */

export type RetryBlockReason =
  'already_retried' | 'not_failed' | 'one_time_code' | 'in_app' | 'source_not_retained';

export interface TimelineStep {
  state:
    'queued' | 'accepted' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'rejected' | 'suppressed';
  label: string;
  at: string | null;
}

export interface DeliveryLogItem {
  id: string;
  channel: NotificationChannel;
  category: NotificationCategory;
  templateKey: string | null;
  templateVersion: number | null;
  recipientMasked: string;
  userId: string | null;
  provider: string;
  environment: string;
  /** True when the labelled development adapter handled it: no real message was sent. */
  developmentAdapter: boolean;
  status: DeliveryStatus;
  providerMessageId: string | null;
  providerStatus: string | null;
  errorSanitized: string | null;
  segments: number | null;
  estimatedCostKobo: string | null;
  subject: string | null;
  isTest: boolean;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  attempts: number;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
  timeline: TimelineStep[];
  /**
   * `confirmed`: a receipt proved delivery; `awaiting_receipt`: accepted, no
   * receipt yet; `not_reported`: SMTP acceptance (the relay never confirms
   * delivery, only bounces); `not_applicable`: never handed to a provider.
   */
  delivery: 'confirmed' | 'awaiting_receipt' | 'not_reported' | 'failed' | 'not_applicable';
  retry: { allowed: boolean; reason: RetryBlockReason | null };
  retryOf: string | null;
  retriedBy: string | null;
}

const RETRYABLE_STATUSES: DeliveryStatus[] = ['failed', 'rejected'];

function retryOfKey(dedupeKey: string | null): string | null {
  const m = dedupeKey?.match(/^retry:([0-9a-f-]{36}):/i);
  return m ? m[1]! : null;
}

function sourceKind(row: AttemptRow): 'test' | 'outbox' | 'retry' | 'otp' | 'unknown' {
  if (row.relatedEntityType === 'otp_challenge') return 'otp';
  if (row.relatedEntityType === 'test_send') return 'test';
  if (retryOfKey(row.dedupeKey)) return 'retry';
  if (/^outbox:\d+:/.test(row.dedupeKey ?? '')) return 'outbox';
  return 'unknown';
}

function retryEligibility(row: AttemptRow, retriedBy: string | null): DeliveryLogItem['retry'] {
  if (retriedBy) return { allowed: false, reason: 'already_retried' };
  if (!RETRYABLE_STATUSES.includes(row.status)) return { allowed: false, reason: 'not_failed' };
  if (row.channel === 'in_app') return { allowed: false, reason: 'in_app' };
  const kind = sourceKind(row);
  if (kind === 'otp') return { allowed: false, reason: 'one_time_code' };
  if (kind === 'unknown') return { allowed: false, reason: 'source_not_retained' };
  return { allowed: true, reason: null };
}

export function deliveryTimeline(row: {
  channel: NotificationChannel;
  status: DeliveryStatus;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  errorSanitized: string | null;
  providerStatus: string | null;
}): TimelineStep[] {
  const steps: TimelineStep[] = [
    {
      state: 'queued',
      label: row.providerStatus === 'deferred' ? 'Queued (quiet hours)' : 'Queued',
      at: row.queuedAt.toISOString(),
    },
  ];
  if (row.status === 'suppressed') {
    steps.push({
      state: 'suppressed',
      label: `Not sent: ${row.errorSanitized ?? 'suppressed'}`,
      at: null,
    });
    return steps;
  }
  if (row.sentAt) {
    steps.push(
      row.channel === 'sms'
        ? { state: 'accepted', label: 'Accepted by the SMS provider', at: row.sentAt.toISOString() }
        : row.channel === 'email'
          ? { state: 'sent', label: 'Accepted by the SMTP relay', at: row.sentAt.toISOString() }
          : { state: 'sent', label: 'Written to the in-app feed', at: row.sentAt.toISOString() },
    );
  }
  if (row.deliveredAt) {
    steps.push({
      state: 'delivered',
      label: row.channel === 'in_app' ? 'Available in the feed' : 'Delivered (provider receipt)',
      at: row.deliveredAt.toISOString(),
    });
  }
  if (row.status === 'failed' || row.status === 'rejected' || row.status === 'bounced') {
    const label =
      row.status === 'bounced'
        ? 'Bounced'
        : row.status === 'rejected'
          ? 'Rejected by the provider or network'
          : row.sentAt
            ? 'Failed after acceptance (provider receipt)'
            : 'Failed before delivery';
    steps.push({ state: row.status, label, at: iso(row.failedAt) });
  }
  return steps;
}

function deliveryState(row: AttemptRow): DeliveryLogItem['delivery'] {
  if (row.status === 'delivered') return 'confirmed';
  if (row.status === 'failed' || row.status === 'rejected' || row.status === 'bounced')
    return 'failed';
  if (row.status === 'accepted') return 'awaiting_receipt';
  if (row.status === 'sent') return row.channel === 'email' ? 'not_reported' : 'awaiting_receipt';
  return 'not_applicable';
}

export function toDeliveryLogItem(row: AttemptRow, retriedBy: string | null): DeliveryLogItem {
  return {
    id: row.id,
    channel: row.channel,
    category: row.category,
    templateKey: row.templateKey,
    templateVersion: row.templateVersion,
    recipientMasked: maskAddress(row.channel, row.recipient),
    userId: row.userId,
    provider: row.provider,
    environment: row.environment,
    developmentAdapter: row.provider === 'dev',
    status: row.status,
    providerMessageId: row.providerMessageId,
    providerStatus: row.providerStatus,
    errorSanitized: row.errorSanitized,
    segments: row.segments,
    estimatedCostKobo: row.estimatedCostKobo === null ? null : row.estimatedCostKobo.toString(),
    subject: row.subject,
    isTest: row.relatedEntityType === 'test_send',
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    attempts: row.attempts,
    queuedAt: row.queuedAt.toISOString(),
    sentAt: iso(row.sentAt),
    deliveredAt: iso(row.deliveredAt),
    failedAt: iso(row.failedAt),
    createdAt: row.createdAt.toISOString(),
    timeline: deliveryTimeline(row),
    delivery: deliveryState(row),
    retry: retryEligibility(row, retriedBy),
    retryOf: retryOfKey(row.dedupeKey),
    retriedBy,
  };
}

async function retryChildren(tx: DbExecutor, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ id: schema.deliveryAttempts.id, dedupeKey: schema.deliveryAttempts.dedupeKey })
    .from(schema.deliveryAttempts)
    .where(
      and(
        like(schema.deliveryAttempts.dedupeKey, 'retry:%'),
        inArray(sql<string>`split_part(${schema.deliveryAttempts.dedupeKey}, ':', 2)`, ids),
      ),
    );
  for (const r of rows) {
    const parent = retryOfKey(r.dedupeKey);
    if (parent && !out.has(parent)) out.set(parent, r.id);
  }
  return out;
}

export interface DeliveryLogQuery {
  channel?: NotificationChannel;
  status?: DeliveryStatus;
  templateKey?: string;
  /** Exact address (normalised) or user id; never a partial match. */
  recipient?: string;
  testOnly?: boolean;
  developmentOnly?: boolean;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface DeliveryLogPage {
  items: DeliveryLogItem[];
  nextCursor: string | null;
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [isoAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!isoAt || !id || Number.isNaN(new Date(isoAt).getTime())) return null;
  return { createdAt: new Date(isoAt), id };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export async function listDeliveryLog(
  db: Db,
  query: DeliveryLogQuery = {},
): Promise<DeliveryLogPage> {
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const cursor = decodeCursor(query.cursor);
  const t = schema.deliveryAttempts;
  let recipientFilter: SQL | undefined;
  if (query.recipient?.trim()) {
    const lookup = normalizeLookupAddress(query.recipient);
    recipientFilter = lookup
      ? eq(t.recipient, lookup.address)
      : or(eq(t.userId, query.recipient.trim()), eq(t.recipient, query.recipient.trim()));
  }
  return withActor(db, systemContext('delivery-log'), async (tx) => {
    const rows = await tx
      .select()
      .from(t)
      .where(
        and(
          query.channel ? eq(t.channel, query.channel) : undefined,
          query.status ? eq(t.status, query.status) : undefined,
          query.templateKey ? eq(t.templateKey, query.templateKey) : undefined,
          recipientFilter,
          query.testOnly ? eq(t.relatedEntityType, 'test_send') : undefined,
          query.developmentOnly ? eq(t.provider, 'dev') : undefined,
          query.from ? gte(t.createdAt, query.from) : undefined,
          query.to ? lte(t.createdAt, query.to) : undefined,
          cursor
            ? or(
                lt(t.createdAt, cursor.createdAt),
                and(eq(t.createdAt, cursor.createdAt), lt(t.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const children = await retryChildren(
      tx,
      page.map((r) => r.id),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDeliveryLogItem(r, children.get(r.id) ?? null)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

export async function getDeliveryLogItem(db: Db, id: string): Promise<DeliveryLogItem | null> {
  return withActor(db, systemContext('delivery-log'), async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, id));
    if (!row) return null;
    const children = await retryChildren(tx, [row.id]);
    return toDeliveryLogItem(row, children.get(row.id) ?? null);
  });
}

/* ---------------------------------------------------------------------- */
/* Retry                                                                   */
/* ---------------------------------------------------------------------- */

export interface RetryResult {
  /** False when an earlier retry already exists; nothing new was sent. */
  created: boolean;
  original: DeliveryLogItem;
  retry: DeliveryLogItem;
  outcome: AttemptOutcome | null;
}

async function loadAttempt(db: Db, id: string): Promise<AttemptRow | null> {
  const [row] = await withActor(db, systemContext('delivery-retry'), (tx) =>
    tx.select().from(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.id, id)),
  );
  return row ?? null;
}

function specMatches(spec: RecipientSpec, row: AttemptRow): boolean {
  if (row.userId) return spec.userId === row.userId;
  if (spec.userId) return false;
  if (row.channel === 'email') return spec.email?.trim().toLowerCase() === row.recipient;
  if (row.channel === 'sms') {
    const phone = normalizeToE164(spec.phone);
    return phone.ok && phone.e164 === row.recipient;
  }
  return false;
}

/** Rebuilds the request that produced `root`, limited to its recipient and channel. */
async function rebuildRequest(
  db: Db,
  root: AttemptRow,
  options: PipelineOptions,
): Promise<Omit<NotificationRequest, 'dedupeScope'> | null> {
  const env = resolveEnv(options);
  if (sourceKind(root) === 'test') {
    const template = root.templateKey ?? 'test_message';
    const [latest] = await withActor(db, systemContext('delivery-retry'), (tx) =>
      tx
        .select({ variables: schema.templates.variables })
        .from(schema.templates)
        .where(and(eq(schema.templates.key, template), eq(schema.templates.channel, root.channel)))
        .orderBy(desc(schema.templates.version))
        .limit(1),
    );
    const samples = sampleVariablesFor(latest?.variables ?? [], options);
    return {
      templateKey: template,
      category: 'transactional',
      channels: [root.channel],
      recipients: [
        root.channel === 'sms'
          ? { phone: root.recipient, name: 'Test recipient' }
          : { email: root.recipient, name: 'Test recipient' },
      ],
      variables: {
        ...samplesToVariables(samples),
        environment: env.appEnv,
        sentAt: env.now().toISOString(),
      },
      label: 'test',
      ignorePreferences: true,
      allowUnverifiedPhone: true,
      relatedEntity: { type: 'test_send', id: null },
    };
  }
  const match = root.dedupeKey?.match(/^outbox:(\d+):/);
  if (!match) return null;
  const [event] = await withActor(db, systemContext('delivery-retry'), (tx) =>
    tx
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, Number(match[1]))),
  );
  if (!event) return null;
  const requests = await resolveOutboxEventRequests(
    db,
    {
      id: event.id,
      type: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      correlationId: event.correlationId,
    },
    options,
  );
  for (const request of requests) {
    if (!root.dedupeKey?.startsWith(`${request.dedupeScope}:`)) continue;
    if (!request.channels.includes(root.channel)) continue;
    const spec = request.recipients.find((s) => specMatches(s, root));
    if (!spec) continue;
    const { dedupeScope: _scope, ...rest } = request;
    return { ...rest, channels: [root.channel], recipients: [spec] };
  }
  return null;
}

/**
 * Retries one failed or rejected attempt by re-rendering the original message
 * for the same recipient and channel under the scope `retry:<attempt id>`.
 * Current preferences, suppressions and verification rules apply again. The
 * retry row is claimed before anything is sent, so repeated or concurrent
 * requests return the same retry and never send twice.
 */
export async function retryDeliveryAttempt(
  db: Db,
  id: string,
  actor: CommunicationsActor,
  options: PipelineOptions = {},
): Promise<RetryResult> {
  const env = resolveEnv(options);
  const row = await loadAttempt(db, id);
  if (!row) throw new NotificationAdminError('not_found', 'delivery attempt not found');
  const existing = await getDeliveryLogItem(db, id);
  if (existing?.retriedBy) {
    const retry = await getDeliveryLogItem(db, existing.retriedBy);
    return { created: false, original: existing, retry: retry!, outcome: null };
  }
  const eligibility = retryEligibility(row, null);
  if (!eligibility.allowed) {
    throw new NotificationAdminError(
      eligibility.reason === 'source_not_retained' ? 'conflict' : 'invalid_transition',
      RETRY_BLOCK_MESSAGES[eligibility.reason!],
      { reason: eligibility.reason },
    );
  }
  // Walk back through earlier retries to the attempt that has a known source.
  let root = row;
  for (let depth = 0; depth < 10; depth += 1) {
    const parentId = retryOfKey(root.dedupeKey);
    if (!parentId) break;
    const parent = await loadAttempt(db, parentId);
    if (!parent) break;
    root = parent;
  }
  const request = await rebuildRequest(db, root, options);
  if (!request) {
    throw new NotificationAdminError('conflict', RETRY_BLOCK_MESSAGES.source_not_retained, {
      reason: 'source_not_retained',
    });
  }
  const scope = `retry:${row.id}`;
  const dedupeKey = `${scope}:${row.userId ?? row.recipient}:${row.channel}`;
  // Claim: one queued row per original attempt. The pipeline then sends through it.
  const claimed = await withActor(
    db,
    systemContext(actor.correlationId ?? 'delivery-retry'),
    (tx) =>
      tx
        .insert(schema.deliveryAttempts)
        .values({
          channel: row.channel,
          category: request.category,
          templateKey: request.templateKey,
          templateVersion: null,
          recipient: row.recipient,
          userId: row.userId,
          provider: row.provider,
          environment: env.production ? 'live' : 'test',
          status: 'queued',
          dedupeKey,
          relatedEntityType: row.relatedEntityType,
          relatedEntityId: row.relatedEntityId,
          queuedAt: env.now(),
        })
        .onConflictDoNothing({ target: schema.deliveryAttempts.dedupeKey })
        .returning({ id: schema.deliveryAttempts.id }),
  );
  if (claimed.length === 0) {
    const again = await getDeliveryLogItem(db, id);
    const retry = again?.retriedBy ? await getDeliveryLogItem(db, again.retriedBy) : null;
    if (!again || !retry) throw new NotificationAdminError('conflict', 'retry already in progress');
    return { created: false, original: again, retry, outcome: null };
  }
  const retryId = claimed[0]!.id;
  const result = await dispatchRequest(
    db,
    { ...request, dedupeScope: scope, correlationId: actor.correlationId ?? null },
    options,
  );
  const outcome =
    result.outcomes.find((o) => o.attemptId === retryId) ?? result.outcomes[0] ?? null;
  if (!outcome || outcome.attemptId !== retryId) {
    // The pipeline did not reach the claimed row (recipient gone, channel error): settle it.
    await withActor(db, systemContext('delivery-retry'), (tx) =>
      tx
        .update(schema.deliveryAttempts)
        .set({
          status: 'failed',
          failedAt: env.now(),
          errorSanitized: outcome?.reason ?? 'recipient_unavailable',
        })
        .where(
          and(
            eq(schema.deliveryAttempts.id, retryId),
            eq(schema.deliveryAttempts.status, 'queued'),
          ),
        ),
    );
  }
  await withActor(db, systemContext('delivery-retry'), async (tx) => {
    const [after] = await tx
      .select({ status: schema.deliveryAttempts.status })
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, retryId));
    await audit(tx, actor, {
      action: 'notifications.delivery.retried',
      entityType: 'delivery_attempt',
      entityId: row.id,
      before: { status: row.status, error: row.errorSanitized },
      after: { retryAttemptId: retryId, status: after?.status ?? null },
    });
  });
  const original = await getDeliveryLogItem(db, id);
  const retry = await getDeliveryLogItem(db, retryId);
  return { created: true, original: original!, retry: retry!, outcome };
}

export const RETRY_BLOCK_MESSAGES: Record<RetryBlockReason, string> = {
  already_retried: 'this attempt was already retried; open the linked retry attempt',
  not_failed: 'only failed or rejected attempts can be retried',
  one_time_code: 'verification codes are never resent; the person requests a new code',
  in_app: 'in-app notifications are written directly and cannot fail at a provider',
  source_not_retained:
    'the event that produced this message is not retained, so it cannot be re-rendered',
};

/* ---------------------------------------------------------------------- */
/* Development receipts                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Development only: asks the labelled development SMS adapter for a signed,
 * Termii-shaped delivery report for one accepted attempt and feeds it through
 * the real webhook handler, so accepted → delivered/failed can be exercised
 * without a provider. Refused in production and for any other adapter.
 */
export async function simulateDevelopmentReceipt(
  db: Db,
  id: string,
  state: 'delivered' | 'failed' | 'rejected' | undefined,
  actor: CommunicationsActor,
  options: PipelineOptions = {},
): Promise<{ webhook: WebhookOutcome; attempt: DeliveryLogItem }> {
  const env = resolveEnv(options);
  if (env.production)
    throw new NotificationAdminError(
      'invalid_transition',
      'receipt simulation is development only',
    );
  const row = await loadAttempt(db, id);
  if (!row) throw new NotificationAdminError('not_found', 'delivery attempt not found');
  if (row.channel !== 'sms' || row.provider !== 'dev' || !row.providerMessageId)
    throw new NotificationAdminError(
      'invalid_transition',
      'only SMS attempts handled by the development adapter can receive a simulated receipt',
    );
  if (row.status !== 'accepted')
    throw new NotificationAdminError(
      'invalid_transition',
      `the attempt is ${row.status}; only accepted attempts await a receipt`,
    );
  const injected = options.providers?.sms;
  const dev = injected instanceof DevSmsProvider ? injected : getDevSmsProvider(env.nodeEnv);
  const receipt = dev.simulateDeliveryReceipt(row.providerMessageId, state);
  if (!receipt)
    throw new NotificationAdminError(
      'conflict',
      'the development adapter no longer holds this message (the server restarted); send a new test',
    );
  const webhook = await processTermiiWebhook(db, receipt.rawBody, receipt.headers, options);
  await withActor(db, systemContext('dev-receipt'), (tx) =>
    audit(tx, actor, {
      action: 'notifications.dev_receipt.simulated',
      entityType: 'delivery_attempt',
      entityId: row.id,
      after: { state: state ?? 'default', action: webhook.action },
    }),
  );
  const attempt = await getDeliveryLogItem(db, id);
  return { webhook, attempt: attempt! };
}

/* ---------------------------------------------------------------------- */
/* Suppressions                                                            */
/* ---------------------------------------------------------------------- */

export interface SuppressionDto {
  id: string;
  channel: NotificationChannel;
  addressMasked: string;
  reason: string;
  /** Plain-language grouping of `reason`. */
  kind: 'stop_reply' | 'hard_bounce' | 'complaint' | 'other';
  source: string | null;
  createdBy: string | null;
  createdAt: string;
}

function suppressionKind(reason: string): SuppressionDto['kind'] {
  if (reason === 'stop_keyword' || reason === 'opt_out') return 'stop_reply';
  if (reason === 'hard_bounce') return 'hard_bounce';
  if (reason === 'complaint') return 'complaint';
  return 'other';
}

const suppressionToDto = (r: SuppressionRow): SuppressionDto => ({
  id: r.id,
  channel: r.channel,
  addressMasked: maskAddress(r.channel, r.address),
  reason: r.reason,
  kind: suppressionKind(r.reason),
  // Manual bounce imports record `manual:<staff id>`; keep only the kind of source.
  source: r.source ? r.source.replace(/^manual:.*/, 'manual') : null,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});

export interface SuppressionListQuery {
  channel?: NotificationChannel;
  kind?: SuppressionDto['kind'];
  /** Exact address (normalised). */
  address?: string;
  cursor?: string;
  limit?: number;
}

export async function listSuppressions(
  db: Db,
  query: SuppressionListQuery = {},
): Promise<{ items: SuppressionDto[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const cursor = decodeCursor(query.cursor);
  const t = schema.suppressions;
  const lookup = query.address ? normalizeLookupAddress(query.address) : null;
  const reasons: Record<SuppressionDto['kind'], string[] | null> = {
    stop_reply: ['stop_keyword', 'opt_out'],
    hard_bounce: ['hard_bounce'],
    complaint: ['complaint'],
    other: null,
  };
  const kindFilter = query.kind
    ? query.kind === 'other'
      ? sql`${t.reason} NOT IN ('stop_keyword','opt_out','hard_bounce','complaint')`
      : inArray(t.reason, reasons[query.kind]!)
    : undefined;
  return withActor(db, systemContext('suppressions'), async (tx) => {
    const rows = await tx
      .select()
      .from(t)
      .where(
        and(
          query.channel ? eq(t.channel, query.channel) : undefined,
          kindFilter,
          query.address ? eq(t.address, lookup?.address ?? query.address.trim()) : undefined,
          cursor
            ? or(
                lt(t.createdAt, cursor.createdAt),
                and(eq(t.createdAt, cursor.createdAt), lt(t.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(suppressionToDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

/**
 * Lifts one suppression with a recorded reason. A STOP reply also left
 * opted-out consent rows; those stay, so transactional and marketing SMS
 * remain blocked until the person replies START or opts in again.
 */
export async function removeSuppression(
  db: Db,
  id: string,
  input: { reason: string },
  actor: CommunicationsActor,
): Promise<{ removed: SuppressionDto; consentStillOptedOut: boolean }> {
  const reason = input.reason.trim();
  if (reason.length < 3)
    throw new NotificationAdminError(
      'validation_failed',
      'a reason of at least 3 characters is required',
      [{ path: 'reason' }],
    );
  return withActor(db, systemContext(actor.correlationId ?? 'suppressions'), async (tx) => {
    const [row] = await tx
      .delete(schema.suppressions)
      .where(eq(schema.suppressions.id, id))
      .returning();
    if (!row) throw new NotificationAdminError('not_found', 'suppression not found');
    let consentStillOptedOut = false;
    if (row.channel === 'sms') {
      const [latest] = await tx
        .select({ status: schema.smsConsents.status })
        .from(schema.smsConsents)
        .where(
          and(
            eq(schema.smsConsents.phoneE164, row.address),
            eq(schema.smsConsents.category, 'transactional'),
          ),
        )
        .orderBy(desc(schema.smsConsents.recordedAt))
        .limit(1);
      consentStillOptedOut = latest?.status === 'opted_out';
    }
    const dto = suppressionToDto(row);
    await audit(tx, actor, {
      action: 'notifications.suppression.removed',
      entityType: 'suppression',
      entityId: row.id,
      before: {
        channel: row.channel,
        address: dto.addressMasked,
        reason: row.reason,
        source: dto.source,
        createdAt: dto.createdAt,
      },
      after: { removed: true, consentStillOptedOut },
      reason,
    });
    return { removed: dto, consentStillOptedOut };
  });
}
