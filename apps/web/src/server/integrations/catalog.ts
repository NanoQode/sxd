import { z } from 'zod';
import type {
  IntegrationEnvironment,
  IntegrationFieldDescriptor,
  IntegrationProvider,
  IntegrationProviderDescriptor,
  IntegrationSecretDescriptor,
} from '@simplexd/contracts';
import { SMTP_ADMIN_FIELDS, smtpSettingsSchema } from '@simplexd/integrations/mail';
import { GOOGLE_OAUTH_CALLBACK_PATH, googleRedirectUri } from '@simplexd/integrations/google';
import { PROVIDER_CURRENCIES } from '@simplexd/integrations/payments';
import { SMS_PURPOSES, TERMII_ADMIN_FIELDS, termiiSettingsSchema } from '@simplexd/integrations/sms';

/**
 * Provider catalogue for Admin → Integrations. Each entry declares the
 * non-secret settings (zod, derived from the adapter's admin field lists),
 * the write-only secret fields, the selectable adapters and where the
 * operator finds the setup guide. Values never live here: the catalogue is
 * fully serialisable and safe to hand to the browser.
 */

export interface ProviderCatalogEntry {
  descriptor: IntegrationProviderDescriptor;
  settingsSchema: z.ZodTypeAny;
  /** Field name → whether it must be present on the version being activated. */
  secretFields: Record<string, { required: boolean }>;
}

const help = (list: ReadonlyArray<{ key: string; help: string }>, key: string): string =>
  list.find((f) => f.key === key)?.help ?? '';

function field(
  key: string,
  label: string,
  kind: IntegrationFieldDescriptor['kind'],
  extra: Partial<IntegrationFieldDescriptor> = {},
): IntegrationFieldDescriptor {
  return { key, label, kind, help: '', required: false, ...extra };
}

function secret(
  key: string,
  label: string,
  help: string,
  required = false,
): IntegrationSecretDescriptor {
  return { key, label, help, required };
}

const appUrl = (): string => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export const PAYMENT_PURPOSES = [
  'invoice',
  'deposit',
  'installment',
  'management_fee',
  'rent',
  'test_payment',
] as const;

const paystackSettingsSchema = z.object({
  currency: z.enum(PROVIDER_CURRENCIES).default('NGN'),
  enabledPurposes: z.array(z.enum(PAYMENT_PURPOSES)).default([]),
  channels: z
    .array(z.enum(['card', 'bank', 'bank_transfer', 'ussd', 'qr', 'mobile_money']))
    .default(['card', 'bank_transfer']),
  /** Business display name shown on the hosted checkout page metadata. */
  displayName: z.string().trim().min(1).max(120).default('SimplexD'),
});

const googleSettingsSchema = z.object({
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/\.apps\.googleusercontent\.com$/, 'must end with .apps.googleusercontent.com'),
  /** Calendar the organiser books into after the OAuth grant; `primary` unless a shared calendar is chosen. */
  calendarId: z.string().trim().min(1).max(200).default('primary'),
  sharedCalendar: z.boolean().default(false),
  workingHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  workingHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('17:00'),
  consultationMinutes: z.number().int().min(15).max(240).default(45),
  bufferMinutes: z.number().int().min(0).max(120).default(15),
});

const storageSettingsSchema = z.object({
  region: z.string().trim().min(1).max(64).default('us-east-1'),
  endpoint: z.string().trim().url().nullable().default(null),
  forcePathStyle: z.boolean().default(false),
  bucketPrivate: z.string().trim().min(3).max(63).default('simplexd-private'),
  bucketQuarantine: z.string().trim().min(3).max(63).default('simplexd-quarantine'),
  bucketDerivatives: z.string().trim().min(3).max(63).nullable().default(null),
  signedUrlTtlSeconds: z.number().int().min(60).max(3600).default(300),
  /** Development adapter only. */
  devRoot: z.string().trim().max(200).default('./uploads-dev'),
});

const scannerSettingsSchema = z.object({
  host: z.string().trim().min(1).max(253).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3310),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
});

const mapsSettingsSchema = z.object({
  styleUrlLight: z.string().trim().url(),
  styleUrlDark: z.string().trim().url().nullable().default(null),
  attribution: z.string().trim().max(1000).nullable().default(null),
  geocodingProvider: z.enum(['none', 'maptiler', 'geoapify', 'mapbox']).default('none'),
});

const termiiAdminSettingsSchema = termiiSettingsSchema
  .omit({ environment: true, templateVersions: true, deliveryReports: true })
  .extend({
    baseUrl: z.string().trim().url().default('https://v3.api.termii.com'),
  });

const smtpAdminSettingsSchema = smtpSettingsSchema;


export const PROVIDER_CATALOG: Record<IntegrationProvider, ProviderCatalogEntry> = {
  paystack: {
    settingsSchema: paystackSettingsSchema,
    secretFields: { secretKey: { required: true }, publicKey: { required: true }, webhookSecret: { required: false } },
    descriptor: {
      provider: 'paystack',
      name: 'Paystack payments',
      summary: 'Hosted checkout, server-side verification and signed webhooks. Test and live keys are kept apart.',
      adapters: [
        { id: 'paystack', label: 'Paystack', development: false },
        { id: 'dev', label: 'Development adapter (simulated gateway)', development: true },
      ],
      devAdapter: 'dev',
      fields: [
        field('currency', 'Settlement currency', 'enum', { options: [...PROVIDER_CURRENCIES], required: true, help: 'NGN is the platform default; amounts are stored as integer kobo.' }),
        field('enabledPurposes', 'Enabled payment purposes', 'string_list', { options: [...PAYMENT_PURPOSES], help: 'Only enabled purposes may create payment attempts.' }),
        field('channels', 'Checkout channels', 'string_list', { options: ['card', 'bank', 'bank_transfer', 'ussd', 'qr', 'mobile_money'], help: 'Channels must also be enabled on the Paystack account.' }),
        field('displayName', 'Display name', 'string', { help: 'Shown in checkout metadata.' }),
      ],
      secrets: [
        secret('secretKey', 'Secret key', 'sk_test_… or sk_live_…; the prefix must match the environment. Write-only, envelope-encrypted.', true),
        secret('publicKey', 'Public key', 'pk_test_… or pk_live_…; used by the inline checkout.', true),
        secret('webhookSecret', 'Webhook secret (optional)', 'Paystack signs webhooks with the secret key; set this only if your account uses a separate signing secret.'),
      ],
      secretsPermission: 'integrations.payment_credentials.manage',
      docsPath: 'docs/providers/paystack.md',
      links: [
        { label: 'Paystack dashboard', href: 'https://dashboard.paystack.com/#/settings/developers', external: true },
      ],
      facts: [{ label: 'Webhook URL', value: `${appUrl()}/api/v1/webhooks/paystack` }],
    },
  },
  termii: {
    settingsSchema: termiiAdminSettingsSchema,
    secretFields: { apiKey: { required: true }, webhookSecret: { required: false } },
    descriptor: {
      provider: 'termii',
      name: 'Termii SMS',
      summary: 'Transactional and marketing SMS with delivery receipts, spend caps and an approved sender ID.',
      adapters: [
        { id: 'termii', label: 'Termii', development: false },
        { id: 'dev', label: 'Development adapter (messages logged, not sent)', development: true },
      ],
      devAdapter: 'dev',
      fields: [
        field('baseUrl', 'Base URL', 'url', { required: true, help: help(TERMII_ADMIN_FIELDS, 'baseUrl') }),
        field('senderId', 'Approved sender ID', 'string', { required: true, help: help(TERMII_ADMIN_FIELDS, 'senderId') }),
        field('enabledPurposes', 'Enabled message purposes', 'string_list', { options: [...SMS_PURPOSES], help: help(TERMII_ADMIN_FIELDS, 'enabledPurposes') }),
        field('dailySendLimit', 'Daily sending limit', 'integer', { min: 0, help: help(TERMII_ADMIN_FIELDS, 'dailySendLimit') }),
        field('dailySpendCapKobo', 'Daily spend cap (kobo)', 'integer', { min: 0, help: help(TERMII_ADMIN_FIELDS, 'dailySpendCapKobo') }),
        field('unitCostKobo', 'Estimated cost per segment (kobo)', 'integer', { min: 0, help: 'Used for previews and spend accounting.' }),
        field('testRecipient', 'Test recipient', 'string', { placeholder: '+2348012345678', help: help(TERMII_ADMIN_FIELDS, 'testRecipient') }),
      ],
      secrets: [
        secret('apiKey', 'API key', help(TERMII_ADMIN_FIELDS, 'apiKey'), true),
        secret('webhookSecret', 'Webhook signing secret', help(TERMII_ADMIN_FIELDS, 'webhookSecret')),
      ],
      secretsPermission: null,
      docsPath: 'docs/providers/termii.md',
      links: [
        { label: 'Termii dashboard', href: 'https://accounts.termii.com/', external: true },
      ],
      facts: [{ label: 'Delivery report webhook URL', value: `${appUrl()}/api/v1/webhooks/termii` }],
    },
  },
  smtp: {
    settingsSchema: smtpAdminSettingsSchema,
    secretFields: { password: { required: false } },
    descriptor: {
      provider: 'smtp',
      name: 'SMTP email',
      summary: 'Outbound transactional email over implicit TLS or STARTTLS with an approved-sender-domain policy.',
      adapters: [
        { id: 'smtp', label: 'SMTP server', development: false },
        { id: 'dev', label: 'Development adapter (Mailpit / log only)', development: true },
      ],
      devAdapter: 'dev',
      fields: [
        field('host', 'SMTP host', 'string', { required: true, help: help(SMTP_ADMIN_FIELDS, 'host') }),
        field('port', 'Port', 'integer', { required: true, min: 1, max: 65535, help: help(SMTP_ADMIN_FIELDS, 'port') }),
        field('security', 'Transport security', 'enum', { required: true, options: ['starttls', 'implicit-tls'], help: help(SMTP_ADMIN_FIELDS, 'security') }),
        field('username', 'Username', 'string', { help: help(SMTP_ADMIN_FIELDS, 'username') }),
        field('fromName', 'Sender name', 'string', { required: true, help: help(SMTP_ADMIN_FIELDS, 'fromName') }),
        field('fromEmail', 'Sender address', 'email', { required: true, help: help(SMTP_ADMIN_FIELDS, 'fromEmail') }),
        field('replyTo', 'Reply-to', 'email', { help: help(SMTP_ADMIN_FIELDS, 'replyTo') }),
        field('approvedSenderDomains', 'Approved sender domains', 'string_list', { help: help(SMTP_ADMIN_FIELDS, 'approvedSenderDomains') }),
        field('testRecipient', 'Test recipient', 'email', { help: help(SMTP_ADMIN_FIELDS, 'testRecipient') }),
      ],
      secrets: [secret('password', 'Password', help(SMTP_ADMIN_FIELDS, 'password'))],
      secretsPermission: null,
      docsPath: 'docs/providers/smtp.md',
      facts: [{ label: 'Host allow-list', value: 'Operator-controlled through SMTP_ALLOWED_HOSTS; hosts outside it are refused.' }],
    },
  },
  google_workspace: {
    settingsSchema: googleSettingsSchema,
    secretFields: { clientSecret: { required: true } },
    descriptor: {
      provider: 'google_workspace',
      name: 'Google Workspace (Calendar + Meet)',
      summary: 'OAuth client for the organiser grant. A client ID and secret alone is not a connected calendar: connect an organiser separately.',
      adapters: [
        { id: 'google', label: 'Google Calendar API', development: false },
        { id: 'dev', label: 'Development adapter (simulated calendar)', development: true },
      ],
      devAdapter: 'dev',
      fields: [
        field('clientId', 'OAuth client ID', 'string', { required: true, help: 'From Google Cloud → APIs & Services → Credentials (Web application).' }),
        field('calendarId', 'Calendar', 'string', { help: '`primary` unless the organiser books into a shared calendar.' }),
        field('sharedCalendar', 'Shared calendar (wider scope)', 'boolean', { help: 'Requests calendar.events instead of calendar.events.owned.' }),
        field('workingHoursStart', 'Working hours start', 'string', { placeholder: '09:00' }),
        field('workingHoursEnd', 'Working hours end', 'string', { placeholder: '17:00' }),
        field('consultationMinutes', 'Consultation length (minutes)', 'integer', { min: 15, max: 240 }),
        field('bufferMinutes', 'Buffer between bookings (minutes)', 'integer', { min: 0, max: 120 }),
      ],
      secrets: [secret('clientSecret', 'OAuth client secret', 'Write-only. Rotate it in Google Cloud and here together.', true)],
      secretsPermission: null,
      docsPath: 'docs/providers/google-workspace.md',
      links: [
        { label: 'Connect an organiser (OAuth grant)', href: '/api/v1/calendar/connect', external: false },
        { label: 'Google Cloud credentials', href: 'https://console.cloud.google.com/apis/credentials', external: true },
      ],
      facts: [
        { label: 'Authorised redirect URI', value: googleRedirectUri(appUrl(), GOOGLE_OAUTH_CALLBACK_PATH) },
      ],
    },
  },
  storage: {
    settingsSchema: storageSettingsSchema,
    secretFields: { accessKeyId: { required: false }, secretAccessKey: { required: false } },
    descriptor: {
      provider: 'storage',
      name: 'Object storage',
      summary: 'S3-compatible buckets for private uploads, quarantine and derivatives, with time-limited signed URLs.',
      adapters: [
        { id: 's3', label: 'S3-compatible (AWS, MinIO, R2)', development: false },
        { id: 'local-dev', label: 'Local development storage', development: true },
      ],
      devAdapter: 'local-dev',
      fields: [
        field('region', 'Region', 'string', { required: true }),
        field('endpoint', 'Custom endpoint', 'url', { help: 'MinIO/R2 only; leave empty for AWS.' }),
        field('forcePathStyle', 'Path-style addressing', 'boolean', { help: 'Required by MinIO and most self-hosted stores.' }),
        field('bucketPrivate', 'Private bucket', 'string', { required: true }),
        field('bucketQuarantine', 'Quarantine bucket', 'string', { required: true }),
        field('bucketDerivatives', 'Derivatives bucket', 'string'),
        field('signedUrlTtlSeconds', 'Signed URL lifetime (seconds)', 'integer', { min: 60, max: 3600 }),
        field('devRoot', 'Development storage folder', 'string', { help: 'Local adapter only.' }),
      ],
      secrets: [
        secret('accessKeyId', 'Access key ID', 'Leave empty to use the instance IAM role.'),
        secret('secretAccessKey', 'Secret access key', 'Write-only; envelope-encrypted.'),
      ],
      secretsPermission: null,
      docsPath: 'docs/providers/storage.md',
      facts: [],
    },
  },
  scanner: {
    settingsSchema: scannerSettingsSchema,
    secretFields: {},
    descriptor: {
      provider: 'scanner',
      name: 'Malware scanner',
      summary: 'ClamAV daemon that every upload passes through before leaving quarantine.',
      adapters: [
        { id: 'clamav', label: 'ClamAV (clamd)', development: false },
        { id: 'dev', label: 'Development scanner (EICAR only)', development: true },
      ],
      devAdapter: 'dev',
      fields: [
        field('host', 'clamd host', 'string', { required: true }),
        field('port', 'clamd port', 'integer', { required: true, min: 1, max: 65535 }),
        field('timeoutMs', 'Scan timeout (ms)', 'integer', { min: 1000, max: 600000 }),
      ],
      secrets: [],
      secretsPermission: null,
      docsPath: 'docs/providers/storage.md',
      facts: [],
    },
  },
  maps: {
    settingsSchema: mapsSettingsSchema,
    secretFields: { apiKey: { required: false } },
    descriptor: {
      provider: 'maps',
      name: 'Map tiles and geocoding',
      summary: 'Licensed vector tile provider for the Nigeria market map; community tile servers are refused in production.',
      adapters: [
        { id: 'licensed', label: 'Licensed provider (MapTiler, Stadia, Mapbox, …)', development: false },
        { id: 'dev', label: 'Development tiles (community/demo servers)', development: true },
      ],
      devAdapter: 'dev',
      fields: [
        field('styleUrlLight', 'Style URL (light)', 'url', { required: true, help: 'Restrict the key to the site origin in the provider dashboard; style URLs are public.' }),
        field('styleUrlDark', 'Style URL (dark)', 'url'),
        field('attribution', 'Attribution HTML', 'string', { help: 'Leave empty to use the provider default.' }),
        field('geocodingProvider', 'Geocoding provider', 'enum', { options: ['none', 'maptiler', 'geoapify', 'mapbox'] }),
      ],
      secrets: [secret('apiKey', 'Server-side API key (optional)', 'Used for geocoding requests made from the server.')],
      secretsPermission: null,
      docsPath: 'docs/providers/maps.md',
      facts: [],
    },
  },
};

export function catalogEntry(provider: IntegrationProvider): ProviderCatalogEntry {
  return PROVIDER_CATALOG[provider];
}

export function isDevelopmentAdapter(provider: IntegrationProvider, adapter: string): boolean {
  return PROVIDER_CATALOG[provider].descriptor.devAdapter === adapter;
}

export function adapterAllowed(provider: IntegrationProvider, adapter: string): boolean {
  return PROVIDER_CATALOG[provider].descriptor.adapters.some((a) => a.id === adapter);
}

export function defaultEnvironmentFor(appEnv: string | undefined): IntegrationEnvironment {
  return appEnv === 'production' ? 'live' : 'test';
}
