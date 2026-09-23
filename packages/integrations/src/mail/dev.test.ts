import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { describe, expect, it } from 'vitest';
import { DevMailProvider } from './dev';
import { createMailProvider, mailProviderFromEnv, smtpConfigFromEnv } from './factory';
import type { SmtpTransportLike } from './smtp';
import type { MailMessage } from './types';

const message: MailMessage = {
  to: [{ email: 'ada@example.org' }],
  from: { email: 'no-reply@localhost', name: 'SimplexD' },
  subject: 'SimplexD SMTP test',
  text: 'This is a test email.',
  html: '<p>This is a test email.</p>',
  idempotencyKey: 'test:1',
};

describe('development mail adapter', () => {
  it('refuses production and requires allowPrivate for forwarding', () => {
    expect(() => new DevMailProvider({ nodeEnv: 'production' })).toThrow(/production/);
    expect(() => createMailProvider({ adapter: 'dev', nodeEnv: 'production' })).toThrow(
      /production/,
    );
    expect(
      () =>
        new DevMailProvider({
          nodeEnv: 'development',
          forward: {
            host: 'localhost',
            port: 1025,
            security: 'none',
            from: { email: 'a@b.co', name: 'A' },
          },
        }),
    ).toThrow(/allowPrivate/);
  });

  it('stores messages in memory and dedupes on the idempotency key', async () => {
    const provider = new DevMailProvider({ nodeEnv: 'test' });
    const first = await provider.send(message);
    const second = await provider.send(message);
    expect(first).toMatchObject({
      accepted: true,
      providerMessageId: expect.stringMatching(/^dev-mail-/),
    });
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]).toMatchObject({
      subject: 'SimplexD SMTP test',
      to: [{ email: 'ada@example.org' }],
    });
    expect(await provider.verifyConnection()).toMatchObject({ ok: true, tls: 'none' });
    expect(provider.describe()).toMatchObject({
      adapter: 'dev',
      host: 'in-memory',
      username: 'not set',
    });
  });

  it('forwards to a Mailpit-style SMTP sink when configured', async () => {
    const created: SMTPTransport.Options[] = [];
    const createTransport = (options: SMTPTransport.Options): SmtpTransportLike => {
      created.push(options);
      return {
        sendMail: async (mail) => ({
          envelope: { from: 'no-reply@localhost', to: ['ada@example.org'] },
          messageId: mail.messageId ?? '<x@localhost>',
          accepted: ['ada@example.org'],
          rejected: [],
          pending: [],
          response: '250 OK',
        }),
        verify: async () => true as const,
        close: () => {},
      };
    };
    const provider = new DevMailProvider({
      nodeEnv: 'development',
      forward: {
        host: 'localhost',
        port: 1025,
        security: 'none',
        allowPrivate: true,
        from: { email: 'no-reply@localhost', name: 'SimplexD' },
      },
      deps: { createTransport },
    });
    const result = await provider.send(message);
    expect(result.accepted).toBe(true);
    expect(created[0]).toMatchObject({ host: '127.0.0.1', port: 1025, ignoreTLS: true });
    expect(provider.outbox[0]!.forwarded).toMatchObject({ accepted: true, response: '250 OK' });
  });

  it('bootstraps from the environment', () => {
    expect(smtpConfigFromEnv({})).toBeNull();
    const config = smtpConfigFromEnv({
      NODE_ENV: 'development',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_SECURITY: 'none',
      MAIL_FROM_ADDRESS: 'no-reply@localhost',
      MAIL_FROM_NAME: 'SimplexD',
      SMTP_ALLOWED_HOSTS: 'smtp.example.com, .sendgrid.net',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 1025,
      security: 'none',
      allowPrivate: true,
      allowedHosts: ['smtp.example.com', '.sendgrid.net'],
    });
    expect(mailProviderFromEnv({ NODE_ENV: 'test' }).id).toBe('dev');
    expect(() => mailProviderFromEnv({ NODE_ENV: 'production' })).toThrow(/SMTP_HOST/);
    expect(() =>
      createMailProvider({
        adapter: 'smtp',
        nodeEnv: 'production',
        smtp: {
          host: 'localhost',
          port: 1025,
          security: 'none',
          allowPrivate: true,
          from: { email: 'a@b.co', name: 'A' },
        },
      }),
    ).toThrow(/allowPrivate/);
  });
});
