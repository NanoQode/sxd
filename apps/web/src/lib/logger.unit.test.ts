import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createWebLogger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON log line under test
type LogLine = Record<string, any>;

/**
 * Web log redaction (brief §19: logs never contain tokens, cookies, secrets
 * or passwords). Lines are captured through an in-memory destination.
 */
function capture(): { log: ReturnType<typeof createWebLogger>; lines: () => string[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { log: createWebLogger(destination), lines: () => chunks };
}

describe('web logger redaction', () => {
  it('redacts authorization and cookie headers, tokens, secrets and passwords at every common depth', () => {
    const { log, lines } = capture();
    log.info(
      {
        req: {
          headers: {
            authorization: 'Bearer eyJhbGciOi.abc',
            cookie: 'sx.session_token=s3cr3t',
            'x-api-key': 'k-1',
            'user-agent': 'vitest',
          },
        },
        headers: { authorization: 'Basic abc==' },
        body: {
          password: 'hunter2',
          newPassword: 'hunter3',
          card: { cardNumber: '4111111111111111', cvv: '123' },
        },
        integration: {
          settings: { host: 'smtp.example.test' },
          secrets: { secretKey: 'sk_live_1' },
        },
        token: 'tok_1',
        accessToken: 'at_1',
        apiKey: 'ak_1',
        otp: '000111',
      },
      'request',
    );
    const [line] = lines();
    expect(line).toBeDefined();
    expect(line).not.toMatch(
      /eyJhbGciOi|s3cr3t|k-1|abc==|hunter2|hunter3|4111111111111111|"123"|sk_live_1|tok_1|at_1|ak_1|000111/,
    );
    const parsed = JSON.parse(line!) as LogLine;
    expect(parsed.req.headers).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      'x-api-key': '[redacted]',
      'user-agent': 'vitest',
    });
    expect(parsed.headers.authorization).toBe('[redacted]');
    expect(parsed.body).toEqual({
      password: '[redacted]',
      newPassword: '[redacted]',
      card: { cardNumber: '[redacted]', cvv: '[redacted]' },
    });
    expect(parsed.integration).toEqual({
      settings: { host: 'smtp.example.test' },
      secrets: { secretKey: '[redacted]' },
    });
    expect(parsed).toMatchObject({
      token: '[redacted]',
      accessToken: '[redacted]',
      apiKey: '[redacted]',
      otp: '[redacted]',
    });
  });

  it('leaves correlation ids, paths, status codes and error codes readable', () => {
    const { log, lines } = capture();
    log.info(
      {
        method: 'POST',
        path: '/api/v1/leads',
        status: 500,
        correlationId: 'c-9',
        err: { code: 'P0001' },
      },
      'request',
    );
    expect(JSON.parse(lines()[0]!)).toMatchObject({
      method: 'POST',
      path: '/api/v1/leads',
      status: 500,
      correlationId: 'c-9',
      err: { code: 'P0001' },
      name: 'web',
    });
  });
});
