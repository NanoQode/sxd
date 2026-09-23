import type { Database } from '@simplexd/db';
import type { MailProvider } from '@simplexd/integrations/mail';
import type { Keyring } from '@simplexd/integrations/secrets';
import type { SmsProvider } from '@simplexd/integrations/sms';
import type { TemplateVariables } from '@simplexd/integrations/templates';

/**
 * Shared vocabulary for the notification pipeline (brief §13/§14).
 *
 * A *request* names a template, a category, the channels wanted and the
 * recipients; the pipeline resolves people, applies preferences, consent,
 * suppressions and quiet hours per channel, renders the approved template,
 * records a `delivery_attempts` row per recipient × channel (deduplicated on
 * the event) and hands the message to the active provider.
 */

export type NotificationChannel = 'email' | 'sms' | 'in_app';
export type NotificationCategory =
  | 'security'
  | 'transactional'
  | 'reminders'
  | 'digests'
  | 'marketing';
export type DeliveryStatus =
  | 'queued'
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'bounced'
  | 'rejected';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['email', 'sms', 'in_app'];
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'security',
  'transactional',
  'reminders',
  'digests',
  'marketing',
];

/** Who should receive a notification; the pipeline fills in the rest from `user`/`user_profiles`. */
export interface RecipientSpec {
  userId?: string | null;
  email?: string | null;
  /** Any format; normalised to E.164 (Nigeria default) before use. */
  phone?: string | null;
  name?: string | null;
  timeZone?: string | null;
  locale?: string | null;
}

export interface ResolvedRecipient {
  userId: string | null;
  email: string | null;
  phoneE164: string | null;
  name: string;
  timeZone: string;
  locale: string;
  /** Explicit marketing consent recorded on the profile, when any. */
  marketingConsentAt: Date | null;
}

export interface InAppContent {
  kind?: string;
  title?: string;
  body?: string | null;
  linkPath?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export interface NotificationRequest {
  templateKey: string;
  category: NotificationCategory;
  channels: NotificationChannel[];
  recipients: RecipientSpec[];
  /** Template variables, optionally per recipient (name, links...). */
  variables: TemplateVariables | ((recipient: ResolvedRecipient) => TemplateVariables);
  /**
   * Stable scope for deduplication: one attempt per scope × recipient × channel.
   * Outbox events use `outbox:<id>`; business keys (`invitation:<id>`) let two
   * events that describe the same message collapse into one send.
   */
  dedupeScope: string;
  /** In-app row content when no `in_app` template exists (or to override link/entity). */
  inApp?: InAppContent;
  relatedEntity?: { type: string; id: string | null } | null;
  organizationId?: string | null;
  correlationId?: string | null;
  /** `test` marks explicit admin test sends in the delivery log. */
  label?: 'test' | null;
  /** Skip the recipient's preference matrix (explicit test sends). Suppressions still apply. */
  ignorePreferences?: boolean;
}

export interface PipelineLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PipelineOptions {
  /** Defaults to APP_ENV; `production` refuses development adapters and unapproved templates. */
  appEnv?: string;
  nodeEnv?: string;
  now?: () => Date;
  appUrl?: string;
  brandName?: string;
  /** Injected providers (tests, admin connection tests). Null means "not configured". */
  providers?: { mail?: MailProvider | null; sms?: SmsProvider | null };
  log?: PipelineLogger;
  /** Secrets keyring override for `loadIntegrationConfig`. */
  keyring?: Keyring;
}

export interface AttemptOutcome {
  attemptId: string | null;
  channel: NotificationChannel;
  recipient: string;
  status: DeliveryStatus | 'skipped' | 'deduplicated';
  reason: string | null;
  providerMessageId?: string | null;
  /** True when the provider asked for a retry with backoff. */
  retryable?: boolean;
  deferredUntil?: Date | null;
}

export interface DispatchResult {
  outcomes: AttemptOutcome[];
  /** At least one channel failed with a retryable provider error. */
  retryable: boolean;
}

export type Db = Database;
