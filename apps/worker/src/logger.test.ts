import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

/**
 * Worker log redaction (brief §19: logs never contain tokens or secrets).
 * Lines are captured through an in-memory destination, so no transport or
 * pretty-printer is involved.
 */
function capture(): { log: ReturnType<typeof createLogger>; lines: () => string[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { log: createLogger('worker-test', destination), lines: () => chunks };
}

describe('worker logger redaction', () => {
  it('redacts credentials in job payloads, provider responses and headers', () => {
    const { log, lines } = capture();
    log.info(
      {
        payload: { password: 'hunter2', otp: '123456', email: 'ada@example.test' },
        provider: { response: { token: 'tok_abc', apiKey: 'key_abc' } },
        req: { headers: { authorization: 'Bearer eyJ.abc', cookie: 'sx.session_token=s3cr3t' } },
        res: { headers: { 'set-cookie': 'sx.session_token=renewed; HttpOnly' } },
        secret: 'top',
        refreshToken: 'rt_1',
        webhookSecret: 'wh_1',
      },
      'job payload',
    );
    const [line] = lines();
    expect(line).toBeDefined();
    expect(line).not.toMatch(/hunter2|123456|tok_abc|key_abc|eyJ\.abc|s3cr3t|renewed|top|rt_1|wh_1/);
    const parsed = JSON.parse(line!) as Record<string, any>;
    expect(parsed.payload).toEqual({
      password: '[redacted]',
      otp: '[redacted]',
      email: 'ada@example.test',
    });
    expect(parsed.provider.response).toEqual({ token: '[redacted]', apiKey: '[redacted]' });
    expect(parsed.req.headers).toEqual({ authorization: '[redacted]', cookie: '[redacted]' });
    expect(parsed.res.headers['set-cookie']).toBe('[redacted]');
    expect(parsed.secret).toBe('[redacted]');
    expect(parsed.refreshToken).toBe('[redacted]');
    expect(parsed.webhookSecret).toBe('[redacted]');
  });

  it('keeps diagnostics such as error codes, job ids and correlation ids', () => {
    const { log, lines } = capture();
    log.warn({ err: { code: '42883', message: 'boom' }, jobId: 'j-1', correlationId: 'c-1' }, 'x');
    const parsed = JSON.parse(lines()[0]!) as Record<string, any>;
    expect(parsed.err).toMatchObject({ code: '42883', message: 'boom' });
    expect(parsed.jobId).toBe('j-1');
    expect(parsed.correlationId).toBe('c-1');
  });
});
