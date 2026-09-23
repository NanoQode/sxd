/**
 * In-memory redirect table for the proxy.
 *
 * The proxy runs before every navigation, so it must not touch the database.
 * Instead it keeps a snapshot of the active redirects fetched from the app's
 * own `GET /api/v1/redirects/snapshot` (a cached, public, read-only route)
 * and refreshes it in the background once it is older than `SNAPSHOT_TTL_MS`
 * (stale-while-revalidate). A request therefore costs one Map lookup; only
 * the very first request after a cold start waits for the fetch, bounded by
 * `FETCH_TIMEOUT_MS`, and falls through to the app when the fetch fails (the
 * not-found boundary then still resolves the redirect, with a 308 instead of
 * the configured status).
 *
 * No `server-only`, no Node-only imports: this module is bundled into the proxy.
 */

export interface RedirectEntry {
  to: string;
  status: number;
}

interface Snapshot {
  version: string;
  table: Map<string, RedirectEntry>;
  fetchedAt: number;
}

export const SNAPSHOT_TTL_MS = 30_000;
export const FETCH_TIMEOUT_MS = 800;
export const SNAPSHOT_PATH = '/api/v1/redirects/snapshot';
export const HIT_PATH = '/api/v1/redirects/hits';

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot | null> | null = null;

export function normalizeRedirectPath(pathname: string): string {
  const bare = pathname.split(/[?#]/)[0] ?? pathname;
  if (bare.length > 1 && bare.endsWith('/')) return bare.slice(0, -1);
  return bare;
}

/** API and framework paths are never redirect candidates (cheap early exit). */
export function isRedirectCandidate(pathname: string): boolean {
  return (
    pathname.startsWith('/') &&
    !pathname.startsWith('/api/') &&
    pathname !== '/api' &&
    !pathname.startsWith('/_next/')
  );
}

export interface SnapshotSource {
  /** Base URL of this deployment as reachable from the proxy itself. */
  baseUrl: string;
  /** Host header of the original request, forwarded so origin-aware code sees the public host. */
  host?: string | null;
  fetchImpl?: typeof fetch;
}

async function fetchSnapshot(source: SnapshotSource): Promise<Snapshot | null> {
  const fetchImpl = source.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (source.host) headers['x-forwarded-host'] = source.host;
    const res = await fetchImpl(`${source.baseUrl}${SNAPSHOT_PATH}`, {
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      version?: unknown;
      items?: Array<{ from?: unknown; to?: unknown; status?: unknown }>;
    };
    const table = new Map<string, RedirectEntry>();
    for (const item of body.items ?? []) {
      if (typeof item.from !== 'string' || typeof item.to !== 'string') continue;
      const status = typeof item.status === 'number' ? item.status : 301;
      table.set(normalizeRedirectPath(item.from), { to: item.to, status });
    }
    return {
      version: typeof body.version === 'string' ? body.version : 'unknown',
      table,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function refresh(source: SnapshotSource): Promise<Snapshot | null> {
  if (!inflight) {
    inflight = fetchSnapshot(source)
      .then((next) => {
        if (next) snapshot = next;
        return next;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Looks a path up in the snapshot, fetching it when absent and refreshing it
 * in the background (`waitUntil`) when stale. Returns null when there is no
 * redirect or the table is unavailable.
 */
export async function lookupRedirect(
  pathname: string,
  source: SnapshotSource,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<RedirectEntry | null> {
  const now = Date.now();
  let current = snapshot;
  if (!current) {
    current = await refresh(source);
  } else if (now - current.fetchedAt > SNAPSHOT_TTL_MS) {
    const pending = refresh(source);
    if (waitUntil) waitUntil(pending);
  }
  if (!current) return null;
  return current.table.get(normalizeRedirectPath(pathname)) ?? null;
}

/** Absolute Location for a redirect target; relative targets keep the original query string. */
export function redirectLocation(entry: RedirectEntry, requestUrl: URL): URL {
  if (/^https:\/\//i.test(entry.to)) return new URL(entry.to);
  const target = new URL(entry.to, requestUrl.origin);
  if (!target.search && requestUrl.search) target.search = requestUrl.search;
  return target;
}

/** Fire-and-forget hit counter (never awaited on the request path). */
export function reportRedirectHit(
  pathname: string,
  source: SnapshotSource,
  clientIp?: string | null,
): Promise<unknown> {
  const fetchImpl = source.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (source.host) headers['x-forwarded-host'] = source.host;
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  return fetchImpl(`${source.baseUrl}${HIT_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: normalizeRedirectPath(pathname) }),
    cache: 'no-store',
  }).catch(() => undefined);
}

/** The snapshot currently held (diagnostics and tests). */
export function currentRedirectSnapshot(): {
  version: string;
  size: number;
  fetchedAt: number;
} | null {
  return snapshot
    ? { version: snapshot.version, size: snapshot.table.size, fetchedAt: snapshot.fetchedAt }
    : null;
}

export function resetRedirectSnapshotForTests(): void {
  snapshot = null;
  inflight = null;
}
