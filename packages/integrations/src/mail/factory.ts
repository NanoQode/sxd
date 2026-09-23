import { z } from 'zod';
import { DevMailProvider, type DevMailOptions } from './dev';
import { SmtpMailProvider, type SmtpConfigInput, type SmtpDeps } from './smtp';
import type { MailProvider } from './types';

/**
 * Adapter selection. Production refuses the development adapter and requires
 * secure transport. Credentials come from Admin → Integrations
 * (envelope-encrypted) or, for automated deployments, the SMTP_* bootstrap
 * variables. Settings never reach the browser: only `describe()` output does.
 */

export interface CreateMailProviderOptions {
  adapter: 'smtp' | 'dev';
  nodeEnv?: string;
  smtp?: SmtpConfigInput;
  dev?: DevMailOptions;
  deps?: SmtpDeps;
}

export function createMailProvider(options: CreateMailProviderOptions): MailProvider {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (options.adapter === 'dev') {
    if (nodeEnv === 'production') {
      throw new Error('Mail adapter "dev" is not permitted in production; configure SMTP');
    }
    return new DevMailProvider({
      ...options.dev,
      nodeEnv,
      deps: options.dev?.deps ?? options.deps,
    });
  }
  if (!options.smtp) throw new Error('SMTP configuration is required for the smtp adapter');
  if (nodeEnv === 'production' && options.smtp.allowPrivate) {
    throw new Error('allowPrivate (localhost/plaintext SMTP) is not permitted in production');
  }
  return new SmtpMailProvider(options.smtp, options.deps);
}

export interface MailEnv {
  NODE_ENV?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURITY?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_ALLOWED_HOSTS?: string;
  MAIL_FROM_NAME?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_REPLY_TO?: string;
  MAIL_APPROVED_SENDER_DOMAINS?: string;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Builds SMTP config from environment; returns null when SMTP_HOST is not set. */
export function smtpConfigFromEnv(env: MailEnv = process.env): SmtpConfigInput | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const nodeEnv = env.NODE_ENV ?? 'development';
  const security = env.SMTP_SECURITY?.trim();
  return {
    host,
    port: Number(env.SMTP_PORT ?? 587),
    security:
      security === 'implicit-tls' || security === 'starttls' || security === 'none'
        ? security
        : 'starttls',
    username: env.SMTP_USERNAME?.trim() || null,
    password: env.SMTP_PASSWORD || null,
    from: {
      email: env.MAIL_FROM_ADDRESS?.trim() || 'no-reply@localhost',
      name: env.MAIL_FROM_NAME?.trim() || 'SimplexD',
    },
    replyTo: env.MAIL_REPLY_TO?.trim() ? { email: env.MAIL_REPLY_TO.trim() } : null,
    allowedHosts: csv(env.SMTP_ALLOWED_HOSTS),
    allowPrivate: nodeEnv !== 'production',
    approvedSenderDomains: csv(env.MAIL_APPROVED_SENDER_DOMAINS),
  };
}

/**
 * Bootstrap from environment. Production: SMTP is mandatory. Development and
 * test: the dev adapter, forwarding to Mailpit when SMTP_HOST is set.
 */
export function mailProviderFromEnv(env: MailEnv = process.env, deps?: SmtpDeps): MailProvider {
  const smtp = smtpConfigFromEnv(env);
  if (env.NODE_ENV === 'production') {
    if (!smtp) throw new Error('SMTP_HOST is required in production');
    return createMailProvider({ adapter: 'smtp', nodeEnv: env.NODE_ENV, smtp, deps });
  }
  return createMailProvider({
    adapter: 'dev',
    nodeEnv: env.NODE_ENV,
    dev: { forward: smtp, from: smtp?.from, deps },
  });
}

/**
 * Non-secret admin settings for the SMTP integration (brief §14). The
 * password is stored through the secrets envelope and referenced by
 * `integration_configs.secret_ids`; the SSRF allow-list (`SMTP_ALLOWED_HOSTS`)
 * is operator-controlled and deliberately not editable from this form.
 */
export const smtpSettingsSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(587),
  security: z.enum(['implicit-tls', 'starttls']).default('starttls'),
  username: z.string().max(256).nullable().default(null),
  fromName: z.string().min(1).max(120),
  fromEmail: z.email(),
  replyTo: z.email().nullable().default(null),
  approvedSenderDomains: z.array(z.string().min(1)).default([]),
  /** Address that receives permission-controlled test emails; always displayed before sending. */
  testRecipient: z.email().nullable().default(null),
});

export type SmtpSettings = z.output<typeof smtpSettingsSchema>;

export interface MailAdminFieldDescriptor {
  key: string;
  label: string;
  secret: boolean;
  help: string;
}

export const SMTP_ADMIN_FIELDS: readonly MailAdminFieldDescriptor[] = [
  {
    key: 'host',
    label: 'SMTP host',
    secret: false,
    help: 'Must be on the operator allow-list (SMTP_ALLOWED_HOSTS).',
  },
  { key: 'port', label: 'Port', secret: false, help: '465 for implicit TLS, 587 for STARTTLS.' },
  {
    key: 'security',
    label: 'Transport security',
    secret: false,
    help: 'Implicit TLS or STARTTLS. Plaintext is only available in development (Mailpit).',
  },
  { key: 'username', label: 'Username', secret: false, help: 'Shown masked after saving.' },
  { key: 'password', label: 'Password', secret: true, help: 'Write-only; stored encrypted.' },
  { key: 'fromName', label: 'Sender name', secret: false, help: 'Display name on outgoing mail.' },
  {
    key: 'fromEmail',
    label: 'Sender address',
    secret: false,
    help: 'Must be in an approved sender domain.',
  },
  {
    key: 'replyTo',
    label: 'Reply-to',
    secret: false,
    help: 'Optional mailbox that receives replies.',
  },
  {
    key: 'approvedSenderDomains',
    label: 'Approved sender domains',
    secret: false,
    help: 'Domains with SPF, DKIM and DMARC published; sends from other domains are refused.',
  },
  {
    key: 'testRecipient',
    label: 'Test recipient',
    secret: false,
    help: 'Receives explicit test emails.',
  },
];
