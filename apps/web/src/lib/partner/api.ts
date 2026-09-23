'use client';

import { useEffect, useState } from 'react';
import { ApiClientError, type ApiErrorEnvelope } from '@/lib/api/client-fetch';

/**
 * Partner-workspace API client. Same envelope handling as `apiFetch`, plus it
 * records the server clock from the `Date` response header so deadline
 * countdowns are measured against the server, not the device clock.
 */

let clockOffsetMs = 0;
let clockObserved = false;
const listeners = new Set<() => void>();

function observeServerDate(res: Response) {
  const header = res.headers.get('date');
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs)) return;
  // The Date header has second precision; round the offset to whole seconds.
  clockOffsetMs = Math.round((serverMs - Date.now()) / 1000) * 1000;
  clockObserved = true;
  for (const l of listeners) l();
}

/** Server-aligned "now". Falls back to the device clock until any API response arrives. */
export function serverNow(): Date {
  return new Date(Date.now() + clockOffsetMs);
}

export function serverClockKnown(): boolean {
  return clockObserved;
}

/** Ticks every second and re-renders when the server offset is learned. */
export function useServerNow(intervalMs = 1000): { now: Date; known: boolean } {
  const [state, setState] = useState(() => ({ now: serverNow(), known: clockObserved }));
  useEffect(() => {
    const update = () => setState({ now: serverNow(), known: clockObserved });
    listeners.add(update);
    const t = setInterval(update, intervalMs);
    return () => {
      listeners.delete(update);
      clearInterval(t);
    };
  }, [intervalMs]);
  return state;
}

export async function partnerFetch<T>(
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
  observeServerDate(res);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorEnvelope | null;
    throw new ApiClientError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function withQuery(
  path: string,
  query: Record<string, string | number | boolean | undefined | null>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Stable message for the honest "not available" states. */
export function describeApiFailure(err: unknown): { title: string; detail: string; code: string } {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case 'feature_disabled':
        return {
          code: err.code,
          title: 'Not enabled for this deployment',
          detail:
            'An administrator has not activated this module yet. Nothing here is hidden from you on purpose; the feature flag is off.',
        };
      case 'forbidden':
        return { code: err.code, title: 'Not available to your account', detail: err.message };
      case 'unauthenticated':
        return { code: err.code, title: 'Session expired', detail: 'Sign in again to continue.' };
      case 'not_found':
        return { code: err.code, title: 'Not found', detail: err.message };
      case 'rate_limited':
        return {
          code: err.code,
          title: 'Too many requests',
          detail: 'Wait a moment and try again.',
        };
      default:
        return {
          code: err.code,
          title: 'Request failed',
          detail: `${err.message}${err.correlationId ? ` (ref ${err.correlationId.slice(0, 8)})` : ''}`,
        };
    }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      code: 'offline',
      title: 'You are offline',
      detail: 'Live data cannot be loaded. Drafts saved on this device remain available.',
    };
  }
  return {
    code: 'network',
    title: 'Could not reach the server',
    detail: err instanceof Error ? err.message : 'Check your connection and try again.',
  };
}

export function isApiCode(err: unknown, code: string): boolean {
  return err instanceof ApiClientError && err.code === code;
}
