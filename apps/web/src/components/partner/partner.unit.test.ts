import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { normalizeChecklist } from '@/lib/partner/checklist';
import { koboToNairaInput, multiplyKobo, nairaInputToKobo, sumKobo } from '@/lib/partner/money';
import { DeadlineCountdown, NotAvailable, RequestFailed, formatRemaining } from './common';
import { VerificationBadge } from './verification-badge';
import { ApiClientError } from '@/lib/api/client-fetch';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');

describe('VerificationBadge', () => {
  it('states what was checked and when, from the profile', () => {
    const html = renderToString(
      createElement(VerificationBadge, {
        zone: 'Africa/Lagos',
        verification: {
          status: 'verified',
          scope: 'CAC registration and two references',
          verifiedAt: '2026-03-02T10:00:00.000Z',
          expiresAt: '2027-03-02T10:00:00.000Z',
          credentials: [{ title: 'COREN licence', issuer: 'COREN', verifiedAt: '2026-03-02T10:00:00.000Z' }],
        },
      }),
    );
    expect(html).toContain('Verified');
    expect(html).toContain('What was checked: CAC registration and two references');
    expect(html).toContain('checked 2 Mar 2026');
    expect(html).toContain('COREN licence');
  });

  it('never implies more than the profile records', () => {
    const html = renderToString(
      createElement(VerificationBadge, {
        zone: 'Africa/Lagos',
        verification: { status: 'unverified', scope: null, verifiedAt: null, expiresAt: null, credentials: [] },
      }),
    );
    expect(html).toContain('Unverified');
    expect(html).toContain('scope of the check not recorded');
    expect(html).toContain('no check recorded');
    expect(html).toContain('No individual credentials are recorded');
  });

  it('labels staff accounts without a partner profile', () => {
    expect(renderToString(createElement(VerificationBadge, { zone: 'UTC', verification: null }))).toContain('Staff account');
  });
});

describe('DeadlineCountdown', () => {
  it('shows a passed deadline as such and says which clock is used', () => {
    const html = renderToString(createElement(DeadlineCountdown, { deadlineIso: '2000-01-01T00:00:00.000Z' }));
    expect(html).toContain('Deadline passed');
    expect(html).toContain('device clock until the server responds');
  });
  it('counts down a future deadline', () => {
    const html = renderToString(createElement(DeadlineCountdown, { deadlineIso: '2999-01-01T00:00:00.000Z' }));
    expect(html).toContain('Closes in');
    expect(html).not.toContain('Deadline passed');
  });
  it('formats remaining time', () => {
    expect(formatRemaining(0)).toBe('passed');
    expect(formatRemaining(90_000)).toBe('00:01:30');
    expect(formatRemaining(2 * 86_400_000 + 3_600_000)).toBe('2d 01h 00m');
  });
});

describe('honest failure states', () => {
  it('explains a disabled feature instead of a generic error', () => {
    const err = new ApiClientError(404, { error: { code: 'feature_disabled', message: 'off', correlationId: 'abc12345' } });
    const html = renderToString(createElement(RequestFailed, { error: err, context: 'Tenders' }));
    expect(html).toContain('Not enabled for this deployment');
    expect(html).not.toContain('Try again');
  });
  it('offers a retry for network failures', () => {
    const html = renderToString(createElement(RequestFailed, { error: new TypeError('Failed to fetch'), onRetry: () => undefined }));
    expect(html).toContain('Try again');
  });
  it('renders not-available with the reason', () => {
    const html = renderToString(createElement(NotAvailable, { title: 'Edit hours', reason: 'no API exists yet' }));
    expect(html).toContain('Not available: no API exists yet');
  });
});

describe('money helpers', () => {
  it('converts naira input to kobo strings without floats', () => {
    expect(nairaInputToKobo('1,250,000.50')).toBe('125000050');
    expect(nairaInputToKobo('₦ 10')).toBe('1000');
    expect(nairaInputToKobo('0.1')).toBe('10');
    expect(nairaInputToKobo('abc')).toBeNull();
    expect(nairaInputToKobo('1.234')).toBeNull();
  });
  it('round-trips kobo to naira input', () => {
    expect(koboToNairaInput('125000050')).toBe('1,250,000.50');
    expect(koboToNairaInput('1000')).toBe('10');
    expect(koboToNairaInput('5')).toBe('0.05');
    expect(koboToNairaInput(null)).toBe('');
  });
  it('sums and multiplies in integer kobo', () => {
    expect(sumKobo(['100', null, '250'])).toBe('350');
    expect(multiplyKobo('1000', '2.5')).toBe('2500');
    expect(multiplyKobo('333', '3')).toBe('999');
    expect(multiplyKobo('1', '0.333')).toBe('0');
  });
});

describe('normalizeChecklist', () => {
  it('accepts strings, objects and envelopes and never drops unknown shapes', () => {
    expect(normalizeChecklist(['Access', 'Roof'])).toEqual([
      { key: 'item_1', label: 'Access', checked: false },
      { key: 'item_2', label: 'Roof', checked: false },
    ]);
    expect(normalizeChecklist({ items: [{ key: 'a', label: 'A', checked: true, note: 'n' }] })).toEqual([
      { key: 'a', label: 'A', checked: true, note: 'n' },
    ]);
    expect(normalizeChecklist('- one\n- two')).toHaveLength(2);
    expect(normalizeChecklist({ odd: true })[0]?.label).toContain('odd');
    expect(normalizeChecklist(null)).toEqual([]);
  });
});
