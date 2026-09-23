import { describe, expect, it } from 'vitest';
import { checkDestination, checkUrlDestination, hostAllowed, isPrivateAddress } from './ssrf';

describe('ssrf guard', () => {
  it('classifies private and reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '100.64.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '41.58.1.1', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('matches allow-lists exactly or by suffix', () => {
    expect(hostAllowed('smtp.sendgrid.net', ['smtp.sendgrid.net'])).toBe(true);
    expect(hostAllowed('smtp.sendgrid.net', ['.sendgrid.net'])).toBe(true);
    expect(hostAllowed('evil.com', ['.sendgrid.net'])).toBe(false);
    expect(hostAllowed('anything', [])).toBe(true);
  });

  it('blocks localhost and metadata unless private is allowed', async () => {
    expect((await checkDestination('localhost', 1025, {})).ok).toBe(false);
    expect((await checkDestination('localhost', 1025, { allowPrivate: true })).ok).toBe(true);
    expect((await checkDestination('169.254.169.254', 80, {})).ok).toBe(false);
    expect((await checkDestination('metadata.google.internal', 80, {})).ok).toBe(false);
  });

  it('enforces ports and protocols on URLs', async () => {
    expect((await checkUrlDestination('http://8.8.8.8/hook', {})).ok).toBe(false);
    expect((await checkUrlDestination('https://user:pw@8.8.8.8/hook', {})).ok).toBe(false);
    expect(
      (await checkUrlDestination('https://8.8.8.8:8443/hook', { allowedPorts: [443] })).ok,
    ).toBe(false);
    expect((await checkUrlDestination('https://8.8.8.8/hook', {})).ok).toBe(true);
  });
});
