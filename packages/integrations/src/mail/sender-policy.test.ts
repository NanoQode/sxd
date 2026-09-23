import { describe, expect, it } from 'vitest';
import { checkApprovedSender, checkDnsRecords, dnsChecklist, emailDomain } from './sender-policy';

describe('sender policy', () => {
  it('checks approved sender domains exactly or by suffix', () => {
    expect(checkApprovedSender('no-reply@simplexd.co', ['simplexd.co']).ok).toBe(true);
    expect(checkApprovedSender('x@mail.simplexd.co', ['simplexd.co']).ok).toBe(false);
    expect(checkApprovedSender('x@mail.simplexd.co', ['.simplexd.co']).ok).toBe(true);
    expect(checkApprovedSender('x@evil.com', ['simplexd.co'])).toMatchObject({
      ok: false,
      domain: 'evil.com',
      reason: expect.stringMatching(/not an approved sender domain/),
    });
    expect(checkApprovedSender('not-an-email', ['simplexd.co']).ok).toBe(false);
    expect(checkApprovedSender('a@b.co', []).ok).toBe(true);
    expect(emailDomain('Ada@Example.ORG.')).toBe('example.org');
  });

  it('produces the SPF, DKIM and DMARC records to publish', () => {
    const checklist = dnsChecklist('SimplexD.co', {
      spfIncludes: ['_spf.google.com'],
      dkimSelector: 'google',
      dmarcReportAddress: 'dmarc@simplexd.co',
    });
    expect(checklist.domain).toBe('simplexd.co');
    expect(checklist.records.map((r) => r.kind)).toEqual(['SPF', 'DKIM', 'DMARC']);
    expect(checklist.records[0]).toMatchObject({
      host: 'simplexd.co',
      recordType: 'TXT',
      value: 'v=spf1 include:_spf.google.com -all',
    });
    expect(checklist.records[1]).toMatchObject({
      host: 'google._domainkey.simplexd.co',
      recordType: 'TXT',
    });
    expect(checklist.records[1]!.value.startsWith('v=DKIM1; k=rsa; p=')).toBe(true);
    expect(checklist.records[2]).toMatchObject({
      host: '_dmarc.simplexd.co',
      value: 'v=DMARC1; p=none; rua=mailto:dmarc@simplexd.co; adkim=r; aspf=r; pct=100',
    });
    expect(checklist.steps.length).toBeGreaterThanOrEqual(3);

    const cname = dnsChecklist('simplexd.co', {
      dkimSelector: 's1',
      dkimCnameTarget: 's1.domainkey.u123.wl.sendgrid.net',
    });
    expect(cname.records[1]).toMatchObject({
      recordType: 'CNAME',
      value: 's1.domainkey.u123.wl.sendgrid.net',
    });
    expect(dnsChecklist('simplexd.co').records[0]!.value).toContain(
      'include:<your-smtp-provider-spf-host>',
    );
  });

  it('maps live resolver results to present/missing/unknown without throwing', async () => {
    const result = await checkDnsRecords('simplexd.co', {
      resolveTxt: async (host) => {
        if (host === 'simplexd.co') return [['v=spf1 include:_spf.google.com', ' -all']];
        if (host === 'default._domainkey.simplexd.co')
          throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
        throw new Error('SERVFAIL');
      },
    });
    expect(result).toMatchObject({
      domain: 'simplexd.co',
      spf: 'present',
      dkim: 'missing',
      dmarc: 'unknown',
    });
    expect(result.details).toHaveLength(3);
    const invalid = await checkDnsRecords('not a domain');
    expect(invalid).toMatchObject({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' });
  });
});
