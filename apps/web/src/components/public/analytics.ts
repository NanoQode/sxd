/**
 * Consent-aware analytics helpers shared by the browser and the API route.
 * Nothing is sent before the visitor grants analytics consent, and payloads
 * that look like they carry an email address are rejected on both sides.
 */

export const CONSENT_COOKIE = 'sx_consent';
export const CONSENT_VERSION = '2026-09';
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
export type ConsentChoice = 'analytics' | 'essential';

const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_LIKE.test(value);
}

/** True when any string anywhere in the value contains an email-like token. */
export function containsEmailLike(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') return looksLikeEmail(value);
  if (Array.isArray(value)) return value.some((v) => containsEmailLike(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => looksLikeEmail(k) || containsEmailLike(v, depth + 1),
    );
  }
  return false;
}

export function parseConsentCookie(cookieHeader: string | null | undefined): ConsentChoice | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    if (rawKey?.trim() !== CONSENT_COOKIE) continue;
    const value = rest.join('=').trim();
    if (value === 'analytics' || value === 'essential') return value;
    return null;
  }
  return null;
}

export function consentCookieValue(choice: ConsentChoice, secure: boolean): string {
  return `${CONSENT_COOKIE}=${choice}; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/* ---------------------------------------------------------------------- */
/* Browser-only helpers (guarded so they are safe to import anywhere).     */
/* ---------------------------------------------------------------------- */

export const CONSENT_EVENT = 'sx:consent';
const SESSION_KEY = 'sx_analytics_session';

export function readConsent(): ConsentChoice | null {
  if (typeof document === 'undefined') return null;
  return parseConsentCookie(document.cookie);
}

export function writeConsent(choice: ConsentChoice): void {
  if (typeof document === 'undefined') return;
  document.cookie = consentCookieValue(choice, window.location.protocol === 'https:');
  if (choice === 'essential') {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable */
    }
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: choice }));
}

function sessionId(): string | null {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return null;
  }
}

export type EventProps = Record<string, string | number | boolean>;

/**
 * Sends an analytics event only when consent is granted. Never includes
 * email addresses; the server rejects them as a second line of defence.
 */
export function trackEvent(eventName: string, props: EventProps = {}): void {
  if (typeof window === 'undefined') return;
  if (readConsent() !== 'analytics') return;
  if (containsEmailLike(props)) return;
  const id = sessionId();
  if (!id) return;
  const body = JSON.stringify({
    eventName,
    path: window.location.pathname,
    props,
    sessionId: id,
  });
  try {
    void fetch('/api/v1/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* never break the page for analytics */
  }
}
