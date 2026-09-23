import type Mail from 'nodemailer/lib/mailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { describe, expect, it } from 'vitest';
import {
  assertSecureTransportOptions,
  buildTransportOptions,
  sanitizeMailError,
  smtpConfigSchema,
  SmtpMailProvider,
  type SmtpConfigInput,
  type SmtpTransportLike,
} from './smtp';
import type { MailMessage } from './types';

const PASSWORD = 'Sup3r-Secret-Pass';
const USERNAME = 'apikey-user';

const baseConfig: SmtpConfigInput = {
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  username: USERNAME,
  password: PASSWORD,
  from: { email: 'no-reply@simplexd.co', name: 'SimplexD' },
};

const message: MailMessage = {
  to: [{ email: 'ada@example.org', name: 'Ada' }],
  from: { email: 'no-reply@simplexd.co', name: 'SimplexD' },
  subject: 'Your consultation is confirmed',
  text: 'Hello Ada',
  html: '<p>Hello Ada</p>',
  tags: ['booking_confirmation'],
  idempotencyKey: 'notification:abc',
};

interface FakeTransportOptions {
  sendMail?: (mail: Mail.Options) => Promise<SMTPTransport.SentMessageInfo>;
  verify?: () => Promise<true>;
}

function fakeTransport(overrides: FakeTransportOptions = {}) {
  const created: SMTPTransport.Options[] = [];
  const sent: Mail.Options[] = [];
  const createTransport = (options: SMTPTransport.Options): SmtpTransportLike => {
    created.push(options);
    return {
      sendMail: async (mail) => {
        sent.push(mail);
        if (overrides.sendMail) return overrides.sendMail(mail);
        return {
          envelope: { from: 'no-reply@simplexd.co', to: ['ada@example.org'] },
          messageId: mail.messageId ?? '<generated@simplexd.co>',
          accepted: ['ada@example.org'],
          rejected: [],
          pending: [],
          response: '250 2.0.0 OK queued as ABC123',
        };
      },
      verify: overrides.verify ?? (async () => true as const),
      close: () => {},
    };
  };
  return { created, sent, createTransport };
}

const publicDestination = async () => ({ ok: true, resolved: ['203.0.113.10'] });

describe('SMTP configuration', () => {
  it("rejects security 'none' unless allowPrivate (development) is set", () => {
    const plaintext = smtpConfigSchema.safeParse({ ...baseConfig, security: 'none' });
    expect(plaintext.success).toBe(false);
    expect(
      smtpConfigSchema.safeParse({ ...baseConfig, security: 'none', allowPrivate: true }).success,
    ).toBe(true);
    expect(smtpConfigSchema.safeParse({ ...baseConfig, password: null }).success).toBe(false);
    expect(
      smtpConfigSchema.safeParse({ ...baseConfig, host: 'smtp.example.com/../x' }).success,
    ).toBe(false);
  });

  it('never disables certificate verification and maps the TLS modes', () => {
    const starttls = buildTransportOptions(smtpConfigSchema.parse(baseConfig));
    expect(starttls.tls?.rejectUnauthorized).not.toBe(false);
    expect(starttls).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      port: 587,
    });
    expect(starttls.tls).toMatchObject({ servername: 'smtp.example.com', minVersion: 'TLSv1.2' });
    expect(starttls.auth).toEqual({ user: USERNAME, pass: PASSWORD });

    const implicit = buildTransportOptions(
      smtpConfigSchema.parse({ ...baseConfig, port: 465, security: 'implicit-tls' }),
    );
    expect(implicit).toMatchObject({ secure: true, requireTLS: false });
    expect(implicit.tls?.rejectUnauthorized).not.toBe(false);

    const plaintext = buildTransportOptions(
      smtpConfigSchema.parse({
        ...baseConfig,
        host: '127.0.0.1',
        port: 1025,
        security: 'none',
        allowPrivate: true,
        username: null,
        password: null,
      }),
    );
    expect(plaintext).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
    expect(plaintext.auth).toBeUndefined();
    expect(plaintext.tls?.servername).toBeUndefined();

    expect(() =>
      assertSecureTransportOptions({ ...starttls, tls: { rejectUnauthorized: false } }),
    ).toThrow(/rejectUnauthorized/);
    expect(() => assertSecureTransportOptions(starttls)).not.toThrow();
  });
});

describe('SMTP adapter', () => {
  it('refuses private hosts through the real destination guard unless allowPrivate', async () => {
    const { created, createTransport } = fakeTransport();
    const blocked = new SmtpMailProvider(
      { ...baseConfig, host: '127.0.0.1', port: 1025 },
      { createTransport },
    );
    const result = await blocked.send(message);
    expect(result).toMatchObject({ accepted: false, errorCode: 'destination', retryable: false });
    expect(created).toHaveLength(0);

    const allowed = new SmtpMailProvider(
      {
        ...baseConfig,
        host: 'localhost',
        port: 1025,
        security: 'none',
        allowPrivate: true,
        username: null,
        password: null,
      },
      { createTransport },
    );
    expect((await allowed.send(message)).accepted).toBe(true);
    expect(created[0]).toMatchObject({ host: '127.0.0.1', port: 1025, ignoreTLS: true });
  });

  it('connects to the address that passed the check while keeping the hostname for TLS', async () => {
    const { created, createTransport } = fakeTransport();
    const provider = new SmtpMailProvider(baseConfig, {
      createTransport,
      checkDestination: async () => ({ ok: true, resolved: ['2001:db8::10', '203.0.113.10'] }),
    });
    const verify = await provider.verifyConnection();
    expect(verify).toMatchObject({ ok: true, tls: 'starttls' });
    expect(verify.message).toContain('ap•••');
    expect(verify.message).not.toContain(PASSWORD);
    expect(created[0]).toMatchObject({
      host: '203.0.113.10',
      tls: { servername: 'smtp.example.com' },
    });
  });

  it('sends with a deterministic Message-ID, tags header and reply-to', async () => {
    const { sent, createTransport } = fakeTransport();
    const provider = new SmtpMailProvider(
      { ...baseConfig, replyTo: { email: 'support@simplexd.co', name: 'SimplexD Support' } },
      { createTransport, checkDestination: publicDestination },
    );
    const first = await provider.send(message);
    const second = await provider.send(message);
    expect(first).toMatchObject({ accepted: true, response: '250 2.0.0 OK queued as ABC123' });
    expect(first.providerMessageId).toMatch(/^<[0-9a-f]{32}@simplexd\.co>$/);
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(sent[0]).toMatchObject({
      from: { name: 'SimplexD', address: 'no-reply@simplexd.co' },
      to: [{ name: 'Ada', address: 'ada@example.org' }],
      replyTo: { name: 'SimplexD Support', address: 'support@simplexd.co' },
      subject: 'Your consultation is confirmed',
      headers: { 'X-SimplexD-Tags': 'booking_confirmation' },
    });
  });

  it('reports envelope rejection when no recipient was accepted', async () => {
    const { createTransport } = fakeTransport({
      sendMail: async (mail) => ({
        envelope: { from: 'no-reply@simplexd.co', to: [] },
        messageId: mail.messageId ?? '<x@simplexd.co>',
        accepted: [],
        rejected: ['ada@example.org'],
        pending: [],
        response: `550 5.1.1 user unknown (auth ${PASSWORD})`,
      }),
    });
    const provider = new SmtpMailProvider(baseConfig, {
      createTransport,
      checkDestination: publicDestination,
    });
    const result = await provider.send(message);
    expect(result).toMatchObject({ accepted: false, errorCode: 'envelope' });
    expect(result.response).not.toContain(PASSWORD);
  });

  it('refuses senders outside the approved domains and invalid messages', async () => {
    const { created, createTransport } = fakeTransport();
    const provider = new SmtpMailProvider(
      { ...baseConfig, approvedSenderDomains: ['simplexd.co'] },
      { createTransport, checkDestination: publicDestination },
    );
    const foreign = await provider.send({ ...message, from: { email: 'x@evil.com', name: 'X' } });
    expect(foreign).toMatchObject({ accepted: false, errorCode: 'sender_not_approved' });
    const noRecipients = await provider.send({ ...message, to: [] });
    expect(noRecipients.errorCode).toBe('invalid_recipient');
    const badHeader = await provider.send({ ...message, headers: { 'X-Test': 'a\r\nBcc: x@y.z' } });
    expect(badHeader.errorCode).toBe('message');
    expect(created).toHaveLength(0);
  });

  it('sanitises verification and send failures so credentials never appear', async () => {
    const authError = Object.assign(
      new Error(`Invalid login: 535 Authentication failed for ${USERNAME} with ${PASSWORD}`),
      {
        code: 'EAUTH',
        response: `535 5.7.8 AUTH PLAIN ${Buffer.from(`\0${USERNAME}\0${PASSWORD}`).toString('base64')} rejected`,
      },
    );
    const { createTransport } = fakeTransport({
      verify: async () => {
        throw authError;
      },
      sendMail: async () => {
        throw authError;
      },
    });
    const provider = new SmtpMailProvider(baseConfig, {
      createTransport,
      checkDestination: publicDestination,
    });
    const verify = await provider.verifyConnection();
    expect(verify).toMatchObject({ ok: false, errorCode: 'auth', tls: 'starttls' });
    expect(verify.message).not.toContain(PASSWORD);
    expect(verify.message).not.toContain(USERNAME);
    expect(verify.message).not.toContain(
      Buffer.from(`\0${USERNAME}\0${PASSWORD}`).toString('base64'),
    );
    expect(verify.message).toContain('[redacted]');
    const sendResult = await provider.send(message);
    expect(sendResult).toMatchObject({ accepted: false, errorCode: 'auth', retryable: false });
    expect(sendResult.errorSanitized).not.toContain(PASSWORD);
    expect(JSON.stringify(provider.describe())).not.toContain(PASSWORD);
    expect(provider.describe().username).toBe('ap•••');
  });

  it('maps nodemailer error codes to stable codes and retry hints', () => {
    const secrets = [PASSWORD];
    expect(
      sanitizeMailError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), secrets),
    ).toMatchObject({ code: 'timeout', retryable: true });
    expect(
      sanitizeMailError(Object.assign(new Error('x'), { code: 'ECONNECTION' }), secrets),
    ).toMatchObject({ code: 'connection', retryable: true });
    expect(
      sanitizeMailError(
        Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
        secrets,
      ),
    ).toMatchObject({ code: 'tls', retryable: false });
    expect(
      sanitizeMailError(
        Object.assign(new Error('x'), { code: 'EENVELOPE', responseCode: 450 }),
        secrets,
      ),
    ).toMatchObject({ code: 'envelope', retryable: true });
    expect(
      sanitizeMailError(
        Object.assign(new Error('x'), { code: 'EENVELOPE', responseCode: 550 }),
        secrets,
      ),
    ).toMatchObject({ code: 'envelope', retryable: false });
    expect(sanitizeMailError(Object.assign(new Error('x'), { code: 'EDNS' }), secrets).code).toBe(
      'dns',
    );
    expect(sanitizeMailError(new Error(`password=${PASSWORD}`), secrets).message).toBe(
      'password=[redacted]',
    );
    expect(sanitizeMailError(null, secrets)).toMatchObject({
      code: 'unknown',
      message: 'unknown error',
    });
  });
});
