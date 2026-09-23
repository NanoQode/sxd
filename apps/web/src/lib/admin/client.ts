'use client';

import { idempotencyKeyHeader } from '@simplexd/contracts';
import { ApiClientError, errorMessage, type ApiErrorEnvelope } from '@/lib/api/client-fetch';

export { ApiClientError, errorMessage };

/** Browser-generated idempotency key for endpoints that require one (refunds, bookings, PO issue). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface AdminFetchInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Send an Idempotency-Key header (payments, bookings, refunds, PO issue). */
  idempotent?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * JSON fetch for admin client components. Same error envelope handling as
 * `apiFetch`, plus optional idempotency keys and custom headers.
 */
export async function adminFetch<T>(path: string, init: AdminFetchInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotent) headers[idempotencyKeyHeader] = newIdempotencyKey();
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
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** True when the API refused because the actor needs a verified authenticator. */
export function isMfaError(err: unknown): boolean {
  return err instanceof ApiClientError && err.code === 'mfa_required';
}
