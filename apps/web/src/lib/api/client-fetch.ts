'use client';

/**
 * Browser-side helper for the versioned API: sends JSON, parses the error
 * envelope and throws an `ApiClientError` carrying the stable code, message,
 * correlation id and validation details so forms can show precise feedback.
 */

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
    retryable?: boolean;
  };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | null;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorEnvelope | null) {
    super(body?.error.message ?? `request failed (${status})`);
    this.name = 'ApiClientError';
    this.code = body?.error.code ?? 'unknown';
    this.status = status;
    this.correlationId = body?.error.correlationId ?? null;
    this.details = body?.error.details;
  }
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
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

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiClientError) {
    const details = Array.isArray(err.details)
      ? (err.details as Array<{ path?: string; message?: string }>)
          .map((d) => (d.path ? `${d.path}: ${d.message ?? ''}` : (d.message ?? '')))
          .filter(Boolean)
          .join('; ')
      : '';
    const ref = err.correlationId ? ` (ref ${err.correlationId.slice(0, 8)})` : '';
    return `${err.message}${details ? ` – ${details}` : ''}${ref}`;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
