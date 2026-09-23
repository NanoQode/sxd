import dns from 'node:dns/promises';

/**
 * Sender-domain policy and the SPF/DKIM/DMARC checklist (brief §14).
 *
 * `dnsChecklist` is documentary: it tells the operator exactly which records
 * to publish. `checkDnsRecords` is an optional live check that never throws;
 * a resolver failure yields `unknown`, not a false "missing".
 */

/** Hostname labels; a single label (`localhost`) is accepted for development senders. */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const domain = input.trim().toLowerCase().replace(/\.$/, '').replace(/^@/, '');
  return HOSTNAME.test(domain) ? domain : null;
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

export interface ApprovedSenderCheck {
  ok: boolean;
  domain: string | null;
  reason?: string;
}

/**
 * Approved sender domains: exact entries (`simplexd.co`) or suffix entries
 * (`.simplexd.co` matches any subdomain and the apex). An empty list means
 * no restriction is configured, which is acceptable only in development;
 * production settings should always list the sending domain(s).
 */
export function checkApprovedSender(email: string, approvedDomains: string[]): ApprovedSenderCheck {
  const domain = emailDomain(email);
  if (!domain) return { ok: false, domain: null, reason: 'sender address is not a valid email' };
  const entries = approvedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return { ok: true, domain };
  const allowed = entries.some((entry) =>
    entry.startsWith('.')
      ? domain === entry.slice(1) || domain.endsWith(entry)
      : domain === entry.replace(/^@/, ''),
  );
  return allowed
    ? { ok: true, domain }
    : { ok: false, domain, reason: `sender domain ${domain} is not an approved sender domain` };
}

export type DnsRecordKind = 'SPF' | 'DKIM' | 'DMARC';

export interface DnsRecordSpec {
  kind: DnsRecordKind;
  host: string;
  recordType: 'TXT' | 'CNAME';
  value: string;
  purpose: string;
  notes: string[];
}

export interface DnsChecklist {
  domain: string;
  records: DnsRecordSpec[];
  steps: string[];
}

export interface DnsChecklistOptions {
  /** `include:` mechanisms for the SPF record, e.g. `_spf.google.com`, `sendgrid.net`. */
  spfIncludes?: string[];
  /** DKIM selector the provider gave you (`default`, `s1`, `google`). */
  dkimSelector?: string;
  /** Public key from the provider; when null a placeholder is shown. */
  dkimPublicKey?: string | null;
  /** Some providers publish DKIM as a CNAME to their own host. */
  dkimCnameTarget?: string | null;
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
  dmarcReportAddress?: string | null;
}

export function dnsChecklist(domainInput: string, options: DnsChecklistOptions = {}): DnsChecklist {
  const domain = normalizeDomain(domainInput) ?? domainInput.trim().toLowerCase();
  const includes = (options.spfIncludes ?? []).map((i) => i.trim()).filter(Boolean);
  const selector = options.dkimSelector?.trim() || 'default';
  const policy = options.dmarcPolicy ?? 'none';
  const rua = options.dmarcReportAddress ?? `dmarc-reports@${domain}`;

  const spfValue =
    includes.length > 0
      ? `v=spf1 ${includes.map((i) => `include:${i}`).join(' ')} -all`
      : 'v=spf1 include:<your-smtp-provider-spf-host> -all';

  const dkim: DnsRecordSpec = options.dkimCnameTarget
    ? {
        kind: 'DKIM',
        host: `${selector}._domainkey.${domain}`,
        recordType: 'CNAME',
        value: options.dkimCnameTarget,
        purpose: 'Lets receivers verify the DKIM signature the provider adds to each message.',
        notes: [
          'CNAME form: the provider rotates keys on its side; do not also publish a TXT record here.',
        ],
      }
    : {
        kind: 'DKIM',
        host: `${selector}._domainkey.${domain}`,
        recordType: 'TXT',
        value: `v=DKIM1; k=rsa; p=${options.dkimPublicKey?.replace(/\s+/g, '') ?? '<public-key-from-provider>'}`,
        purpose: 'Lets receivers verify the DKIM signature the provider adds to each message.',
        notes: [
          'The selector must match the one configured at the provider (or in the SMTP relay).',
          'Long keys may need to be split into several quoted strings inside one TXT record.',
        ],
      };

  return {
    domain,
    records: [
      {
        kind: 'SPF',
        host: domain,
        recordType: 'TXT',
        value: spfValue,
        purpose: 'Declares which servers may send mail from this domain.',
        notes: [
          'Exactly one SPF TXT record per domain; merge includes if one already exists.',
          'Keep the total DNS lookups (include/a/mx/redirect) at 10 or fewer.',
          'Use -all (fail) once every legitimate sender is listed; ~all (softfail) while migrating.',
        ],
      },
      dkim,
      {
        kind: 'DMARC',
        host: `_dmarc.${domain}`,
        recordType: 'TXT',
        value: `v=DMARC1; p=${policy}; rua=mailto:${rua}; adkim=r; aspf=r; pct=100`,
        purpose:
          'Tells receivers what to do when SPF/DKIM alignment fails and where to send reports.',
        notes: [
          'Start with p=none to collect reports, then move to quarantine and finally reject.',
          'The From: header domain must align with the SPF domain or the DKIM d= domain.',
        ],
      },
    ],
    steps: [
      `Publish the SPF TXT record at ${domain}.`,
      `Publish the DKIM record at ${selector}._domainkey.${domain} using the key or CNAME from your provider.`,
      `Publish the DMARC TXT record at _dmarc.${domain} and monitor the aggregate reports.`,
      'Send a test email from Admin → Integrations → Email and inspect the Authentication-Results header at the receiver.',
      'Only then set the sender domain as approved and activate the integration.',
    ],
  };
}

export type DnsRecordPresence = 'present' | 'missing' | 'unknown';

export interface DnsLiveCheck {
  domain: string;
  spf: DnsRecordPresence;
  dkim: DnsRecordPresence;
  dmarc: DnsRecordPresence;
  details: string[];
}

export type TxtResolver = (hostname: string) => Promise<string[][]>;

export interface DnsCheckOptions {
  dkimSelector?: string;
  resolveTxt?: TxtResolver;
  timeoutMs?: number;
}

async function lookupTxt(
  resolveTxt: TxtResolver,
  host: string,
  predicate: (record: string) => boolean,
  timeoutMs: number,
): Promise<{ presence: DnsRecordPresence; detail: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
    timer.unref?.();
  });
  try {
    const records = await Promise.race([resolveTxt(host), timeout]);
    const joined = records.map((chunks) => chunks.join(''));
    const found = joined.some(predicate);
    return found
      ? { presence: 'present', detail: `${host}: record found` }
      : {
          presence: 'missing',
          detail: `${host}: ${joined.length} TXT record(s) but none matched the expected format`,
        };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { presence: 'missing', detail: `${host}: no TXT record` };
    }
    const message = err instanceof Error ? err.message : 'lookup failed';
    return { presence: 'unknown', detail: `${host}: could not be checked (${message})` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Live SPF/DKIM/DMARC presence check. Never throws. */
export async function checkDnsRecords(
  domainInput: string,
  options: DnsCheckOptions = {},
): Promise<DnsLiveCheck> {
  const domain = normalizeDomain(domainInput);
  if (!domain) {
    return {
      domain: domainInput,
      spf: 'unknown',
      dkim: 'unknown',
      dmarc: 'unknown',
      details: ['invalid domain'],
    };
  }
  const resolveTxt = options.resolveTxt ?? ((host: string) => dns.resolveTxt(host));
  const timeoutMs = options.timeoutMs ?? 5000;
  const selector = options.dkimSelector?.trim() || 'default';
  const [spf, dkim, dmarc] = await Promise.all([
    lookupTxt(resolveTxt, domain, (r) => /^v=spf1\b/i.test(r.trim()), timeoutMs),
    lookupTxt(
      resolveTxt,
      `${selector}._domainkey.${domain}`,
      (r) => /(^|;)\s*v=DKIM1\b/i.test(r) || /(^|;)\s*p=/.test(r),
      timeoutMs,
    ),
    lookupTxt(resolveTxt, `_dmarc.${domain}`, (r) => /^v=DMARC1\b/i.test(r.trim()), timeoutMs),
  ]);
  return {
    domain,
    spf: spf.presence,
    dkim: dkim.presence,
    dmarc: dmarc.presence,
    details: [spf.detail, dkim.detail, dmarc.detail],
  };
}
