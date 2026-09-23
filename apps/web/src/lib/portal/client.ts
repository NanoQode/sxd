'use client';

import { ApiClientError, type ApiErrorEnvelope } from '@/lib/api/client-fetch';

/**
 * Browser helper for portal mutations. Extends the shared `apiFetch` with
 * custom headers (Idempotency-Key for quote acceptance, payment attempts and
 * bookings) and exposes the correlation id of failures so error states can
 * show a reference that support can look up.
 */

export { ApiClientError } from '@/lib/api/client-fetch';

export interface PortalFetchInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function portalFetch<T>(path: string, init: PortalFetchInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
    signal: init.signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorEnvelope | null;
    throw new ApiClientError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Idempotency keys are generated once per user intent and reused on retries. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `ui-${crypto.randomUUID()}`;
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface DescribedError {
  message: string;
  code: string | null;
  correlationId: string | null;
  status: number | null;
}

/** Turns any failure into a customer-safe message plus the correlation id for support. */
export function describeError(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): DescribedError {
  if (err instanceof ApiClientError) {
    const details = Array.isArray(err.details)
      ? (err.details as Array<{ path?: string; message?: string }>)
          .map((d) => (d.path ? `${d.path}: ${d.message ?? ''}` : (d.message ?? '')))
          .filter(Boolean)
          .join('; ')
      : '';
    return {
      message: details ? `${err.message} – ${details}` : err.message,
      code: err.code,
      correlationId: err.correlationId,
      status: err.status,
    };
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { message: 'Cancelled.', code: 'aborted', correlationId: null, status: null };
  }
  if (err instanceof Error && err.message) {
    return { message: err.message, code: null, correlationId: null, status: null };
  }
  return { message: fallback, code: null, correlationId: null, status: null };
}

/** Signed download URL for a clean file (expires after a few minutes). */
export async function requestDownloadUrl(
  fileId: string,
  options: { variant?: 'thumb' | 'web'; disposition?: 'inline' | 'attachment' } = {},
): Promise<{ url: string; expiresAt: string; contentType: string }> {
  const query = new URLSearchParams();
  if (options.variant) query.set('variant', options.variant);
  if (options.disposition) query.set('disposition', options.disposition);
  const qs = query.toString();
  const res = await fetch(`/api/v1/files/${fileId}/download${qs ? `?${qs}` : ''}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorEnvelope | null;
    throw new ApiClientError(res.status, body);
  }
  return (await res.json()) as { url: string; expiresAt: string; contentType: string };
}
