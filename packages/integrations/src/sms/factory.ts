import { z } from 'zod';
import { DevSmsProvider, type DevSmsOptions } from './dev';
import {
  TERMII_DEFAULT_BASE_URL,
  TERMII_SENDER_ID_PATTERN,
  TermiiSmsProvider,
  type TermiiConfigInput,
  type TermiiDeps,
} from './termii';
import type { SmsProvider } from './types';

/**
 * Adapter selection. Production refuses the development adapter. Credentials
 * come from Admin → Integrations (envelope-encrypted) or, for automated
 * deployments, from the optional TERMII_* bootstrap variables.
 */

export interface CreateSmsProviderOptions {
  adapter: 'termii' | 'dev';
  nodeEnv?: string;
  termii?: TermiiConfigInput;
  dev?: DevSmsOptions;
  deps?: TermiiDeps;
}

export function createSmsProvider(options: CreateSmsProviderOptions): SmsProvider {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (options.adapter === 'dev') {
    if (nodeEnv === 'production') {
      throw new Error('SMS adapter "dev" is not permitted in production; configure Termii');
    }
    return new DevSmsProvider({ ...options.dev, nodeEnv });
  }
  if (!options.termii) throw new Error('Termii configuration is required for the termii adapter');
  return new TermiiSmsProvider(options.termii, options.deps);
}

export interface SmsEnv {
  NODE_ENV?: string;
  TERMII_API_KEY?: string;
  TERMII_BASE_URL?: string;
  TERMII_SENDER_ID?: string;
  TERMII_ENVIRONMENT?: string;
  TERMII_WEBHOOK_SECRET?: string;
  TERMII_ALLOWED_HOSTS?: string;
}

/** Bootstrap from environment: Termii when an API key is present, otherwise the dev adapter (non-production only). */
export function smsProviderFromEnv(env: SmsEnv = process.env, deps?: TermiiDeps): SmsProvider {
  const apiKey = env.TERMII_API_KEY?.trim();
  if (apiKey) {
    const allowedHosts = (env.TERMII_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    return createSmsProvider({
      adapter: 'termii',
      nodeEnv: env.NODE_ENV,
      termii: {
        apiKey,
        baseUrl: env.TERMII_BASE_URL?.trim() || TERMII_DEFAULT_BASE_URL,
        senderId: env.TERMII_SENDER_ID?.trim() ?? '',
        environment: env.TERMII_ENVIRONMENT === 'live' ? 'live' : 'test',
        webhookSecret: env.TERMII_WEBHOOK_SECRET?.trim() || null,
        ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      },
      deps,
    });
  }
  return createSmsProvider({ adapter: 'dev', nodeEnv: env.NODE_ENV });
}

export const SMS_PURPOSES = [
  'booking_confirmation',
  'booking_reminder',
  'visit_change',
  'invoice_due',
  'report_ready',
  'urgent_decision',
  'otp',
  'marketing',
  'test_message',
] as const;
export type SmsPurpose = (typeof SMS_PURPOSES)[number];

/**
 * Non-secret admin settings for the Termii integration (brief §13). Secrets
 * (`apiKey`, `webhookSecret`) are stored through the secrets envelope and
 * referenced by `integration_configs.secret_ids`, never inside `settings`.
 */
export const termiiSettingsSchema = z.object({
  baseUrl: z.string().min(1).default(TERMII_DEFAULT_BASE_URL),
  senderId: z.string().regex(TERMII_SENDER_ID_PATTERN),
  environment: z.enum(['test', 'live']).default('test'),
  enabledPurposes: z.array(z.enum(SMS_PURPOSES)).default([]),
  /** Template key → approved version used for sends. */
  templateVersions: z.record(z.string(), z.number().int().min(1)).default({}),
  /** Hard ceiling on messages per day (0 disables sending). */
  dailySendLimit: z.number().int().min(0).default(500),
  /** Daily spend cap in kobo; null = no cap. */
  dailySpendCapKobo: z.number().int().min(0).nullable().default(null),
  /** Estimated price per segment in kobo, used for previews and spend accounting. */
  unitCostKobo: z.number().int().min(0).default(400),
  deliveryReports: z
    .object({
      /** Public webhook path shown to the operator: `${APP_URL}/api/v1/webhooks/termii`. */
      webhookPath: z.string().default('/api/v1/webhooks/termii'),
      /** Whether the operator has pasted the signing secret (secret itself lives in the vault). */
      secretConfigured: z.boolean().default(false),
      /** Poll the history endpoint for messages without a receipt after this many minutes. */
      pollAfterMinutes: z.number().int().min(1).default(30),
    })
    .default({
      webhookPath: '/api/v1/webhooks/termii',
      secretConfigured: false,
      pollAfterMinutes: 30,
    }),
  /** E.164 recipient for permission-controlled test sends; always shown before sending. */
  testRecipient: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/)
    .nullable()
    .default(null),
});

export type TermiiSettings = z.output<typeof termiiSettingsSchema>;

export interface AdminFieldDescriptor {
  key: string;
  label: string;
  secret: boolean;
  help: string;
}

/** Field list for the Admin → Integrations → SMS form. */
export const TERMII_ADMIN_FIELDS: readonly AdminFieldDescriptor[] = [
  {
    key: 'apiKey',
    label: 'API key',
    secret: true,
    help: 'From the Termii dashboard. Stored encrypted; only its fingerprint is shown after saving.',
  },
  {
    key: 'baseUrl',
    label: 'Base URL',
    secret: false,
    help: 'Account-specific, copied from the Termii dashboard. https only. Default https://v3.api.termii.com.',
  },
  {
    key: 'senderId',
    label: 'Approved sender ID',
    secret: false,
    help: '3–11 letters or digits, registered and approved by Termii before messages deliver.',
  },
  { key: 'environment', label: 'Environment', secret: false, help: 'test or live; kept separate.' },
  {
    key: 'enabledPurposes',
    label: 'Enabled message purposes',
    secret: false,
    help: 'Only enabled purposes are sent; everything else is recorded as suppressed.',
  },
  {
    key: 'templateVersions',
    label: 'Template versions',
    secret: false,
    help: 'Approved template version per purpose.',
  },
  { key: 'dailySendLimit', label: 'Daily sending limit', secret: false, help: 'Messages per day.' },
  {
    key: 'dailySpendCapKobo',
    label: 'Daily spend cap',
    secret: false,
    help: 'Kobo per day; blocks transactional and marketing sends when reached (security messages still go).',
  },
  {
    key: 'deliveryReports',
    label: 'Delivery reports',
    secret: false,
    help: 'Webhook URL to paste into the Termii console, plus polling fallback.',
  },
  {
    key: 'webhookSecret',
    label: 'Webhook signing secret',
    secret: true,
    help: 'Value Termii signs X-Termii-Signature with (see the webhook config page).',
  },
  {
    key: 'testRecipient',
    label: 'Test recipient',
    secret: false,
    help: 'E.164 number that receives permission-controlled test messages.',
  },
];
