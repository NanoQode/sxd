import { isIP } from 'node:net';
import dns from 'node:dns/promises';

/**
 * Outbound destination policy for admin-configurable endpoints (SMTP hosts,
 * webhook URLs, tile providers). Blocks loopback, private, link-local and
 * cloud-metadata ranges so a settings form can never be turned into an SSRF
 * primitive. Development mode may allow localhost for Mailpit explicitly.
 */

export interface DestinationPolicy {
  /** Exact hostnames or suffixes (".example.com") that are allowed. Empty = any public host. */
  allowedHosts?: string[];
  /** Permit localhost / private addresses (development only). */
  allowPrivate?: boolean;
  /** Allowed ports; empty = any. */
  allowedPorts?: number[];
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^224\./,
  /^240\./,
  /^255\.255\.255\.255$/,
];

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return PRIVATE_V4.some((re) => re.test(ip));
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return false;
  }
  return true;
}

export function hostAllowed(hostname: string, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const h = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith('.')) return h.endsWith(e) || h === e.slice(1);
    return h === e;
  });
}

export interface DestinationCheck {
  ok: boolean;
  reason?: string;
  resolved?: string[];
}

/**
 * Validates a hostname (or IP) against the policy, resolving DNS so that a
 * public name pointing at a private address is rejected.
 */
export async function checkDestination(
  hostname: string,
  port: number | undefined,
  policy: DestinationPolicy,
): Promise<DestinationCheck> {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'empty host' };
  if (
    policy.allowedPorts &&
    policy.allowedPorts.length > 0 &&
    port !== undefined &&
    !policy.allowedPorts.includes(port)
  ) {
    return { ok: false, reason: `port ${port} is not permitted` };
  }
  if (!hostAllowed(host, policy.allowedHosts))
    return { ok: false, reason: `host ${host} is not in the allow-list` };
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal')
  ) {
    return policy.allowPrivate
      ? { ok: true, resolved: ['127.0.0.1'] }
      : { ok: false, reason: 'local and internal hosts are blocked' };
  }
  if (isIP(host)) {
    if (isPrivateAddress(host) && !policy.allowPrivate)
      return { ok: false, reason: `address ${host} is private or reserved` };
    return { ok: true, resolved: [host] };
  }
  let addresses: string[];
  try {
    const results = await dns.lookup(host, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    return { ok: false, reason: `could not resolve ${host}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `no addresses for ${host}` };
  const bad = addresses.filter((a) => isPrivateAddress(a));
  if (bad.length > 0 && !policy.allowPrivate)
    return {
      ok: false,
      reason: `${host} resolves to a private or reserved address`,
      resolved: addresses,
    };
  return { ok: true, resolved: addresses };
}

export async function checkUrlDestination(
  url: string,
  policy: DestinationPolicy & { allowedProtocols?: string[] },
): Promise<DestinationCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  const protocols = policy.allowedProtocols ?? ['https:'];
  if (!protocols.includes(parsed.protocol))
    return { ok: false, reason: `${parsed.protocol} is not permitted` };
  if (parsed.username || parsed.password)
    return { ok: false, reason: 'credentials in URLs are not permitted' };
  const port = parsed.port ? Number(parsed.port) : undefined;
  return checkDestination(parsed.hostname, port, policy);
}
