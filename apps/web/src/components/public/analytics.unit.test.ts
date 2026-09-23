import { describe, expect, it } from 'vitest';
import {
  consentCookieValue,
  containsEmailLike,
  looksLikeEmail,
  parseConsentCookie,
} from './analytics';

describe('email detection', () => {
  it('detects email-like strings anywhere in a payload', () => {
    expect(looksLikeEmail('ada@example.com')).toBe(true);
    expect(looksLikeEmail('page_view')).toBe(false);
    expect(containsEmailLike({ props: { note: 'contact me at ada@example.com' } })).toBe(true);
    expect(containsEmailLike({ 'ada@example.com': true })).toBe(true);
    expect(containsEmailLike(['fine', { nested: ['ok', 'still ok'] }])).toBe(false);
    expect(containsEmailLike(42)).toBe(false);
  });
});

describe('consent cookie', () => {
  it('parses only the two known values', () => {
    expect(parseConsentCookie('a=1; sx_consent=analytics; b=2')).toBe('analytics');
    expect(parseConsentCookie('sx_consent=essential')).toBe('essential');
    expect(parseConsentCookie('sx_consent=yes')).toBeNull();
    expect(parseConsentCookie(null)).toBeNull();
    expect(parseConsentCookie('other=analytics')).toBeNull();
  });

  it('writes a SameSite cookie scoped to the site', () => {
    const value = consentCookieValue('analytics', true);
    expect(value).toContain('sx_consent=analytics');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Secure');
    expect(consentCookieValue('essential', false)).not.toContain('Secure');
  });
});
