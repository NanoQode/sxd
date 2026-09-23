import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { normalizeChecklist } from '@/lib/partner/checklist';
import { koboToNairaInput, multiplyKobo, nairaInputToKobo, sumKobo } from '@/lib/partner/money';
import { DeadlineCountdown, NotAvailable, RequestFailed, formatRemaining } from './common';
import { VerificationBadge } from './verification-badge';
import { ApiClientError } from '@/lib/api/client-fetch';
import { partnerFetch, serverClockKnown, serverNow } from '@/lib/partner/api';
import { partnerModules } from '@/lib/partner/nav';
import { syncStateLabel, syncStateTone } from './visits/sync-state';

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
          scope: 'CAC registration and two references.',
          verifiedAt: '2026-03-02T10:00:00.000Z',
          expiresAt: '2027-03-02T10:00:00.000Z',
          credentials: [
            { title: 'COREN licence', issuer: 'COREN', verifiedAt: '2026-03-02T10:00:00.000Z' },
          ],
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
        verification: {
          status: 'unverified',
          scope: null,
          verifiedAt: null,
          expiresAt: null,
          credentials: [],
        },
      }),
    );
    expect(html).toContain('Unverified');
    expect(html).toContain('scope of the check not recorded');
    expect(html).toContain('no check recorded');
    expect(html).toContain('No individual credentials are recorded');
  });

  it('labels staff accounts without a partner profile', () => {
    expect(
      renderToString(createElement(VerificationBadge, { zone: 'UTC', verification: null })),
    ).toContain('Staff account');
  });
});

describe('DeadlineCountdown', () => {
  it('shows a passed deadline as such and says which clock is used', () => {
    const html = renderToString(
      createElement(DeadlineCountdown, { deadlineIso: '2000-01-01T00:00:00.000Z' }),
    );
    expect(html).toContain('Deadline passed');
    expect(html).toContain('device clock until the server responds');
  });
  it('counts down a future deadline', () => {
    const html = renderToString(
      createElement(DeadlineCountdown, { deadlineIso: '2999-01-01T00:00:00.000Z' }),
    );
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
    const err = new ApiClientError(404, {
      error: { code: 'feature_disabled', message: 'off', correlationId: 'abc12345' },
    });
    const html = renderToString(createElement(RequestFailed, { error: err, context: 'Tenders' }));
    expect(html).toContain('Not enabled for this deployment');
    expect(html).not.toContain('Try again');
  });
  it('offers a retry for network failures', () => {
    const html = renderToString(
      createElement(RequestFailed, {
        error: new TypeError('Failed to fetch'),
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain('Try again');
  });
  it('renders not-available with the reason', () => {
    const html = renderToString(
      createElement(NotAvailable, { title: 'Edit hours', reason: 'no API exists yet' }),
    );
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
    expect(
      normalizeChecklist({ items: [{ key: 'a', label: 'A', checked: true, note: 'n' }] }),
    ).toEqual([{ key: 'a', label: 'A', checked: true, note: 'n' }]);
    expect(normalizeChecklist('- one\n- two')).toHaveLength(2);
    expect(normalizeChecklist({ odd: true })[0]?.label).toContain('odd');
    expect(normalizeChecklist(null)).toEqual([]);
  });
});

describe('role-based navigation', () => {
  const on = { tendering: true, procurement: true };
  const partner = (partnerType: string, flags = on) => ({
    isPartner: true,
    partnerType,
    isStaffInspector: false,
    flags,
  });

  it('gives contractors tenders but not RFQs or field capture', () => {
    const m = partnerModules(partner('contractor'));
    expect(m.has('tenders')).toBe(true);
    expect(m.has('assignments')).toBe(true);
    expect(m.has('rfqs')).toBe(false);
    expect(m.has('visits')).toBe(false);
  });
  it('gives vendors RFQs and orders but no field capture', () => {
    const m = partnerModules(partner('vendor'));
    expect(m.has('rfqs')).toBe(true);
    expect(m.has('tenders')).toBe(false);
    expect(m.has('visits')).toBe(false);
  });
  it('gives legal partners evidence and reports only', () => {
    const m = partnerModules(partner('legal'));
    expect(m.has('evidence')).toBe(true);
    expect(m.has('reports')).toBe(true);
    expect(m.has('visits')).toBe(false);
    expect(m.has('tenders')).toBe(false);
  });
  it('gives staff inspectors visits without commercial modules', () => {
    const m = partnerModules({
      isPartner: false,
      partnerType: null,
      isStaffInspector: true,
      flags: on,
    });
    expect(m.has('visits')).toBe(true);
    expect(m.has('tenders')).toBe(false);
    expect(m.has('rfqs')).toBe(false);
  });
  it('hides expansion modules while their feature flag is off', () => {
    const m = partnerModules(partner('other', { tendering: false, procurement: false }));
    expect(m.has('tenders')).toBe(false);
    expect(m.has('rfqs')).toBe(false);
  });
});

describe('sync state labels', () => {
  it('always pairs a colour with a word', () => {
    expect(syncStateLabel('unsynced')).toBe('Unsynced');
    expect(syncStateTone('unsynced')).toBe('warning');
    expect(syncStateLabel('rejected')).toBe('Rejected by server');
    expect(syncStateTone('synced')).toBe('success');
  });
});

describe('partnerFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for JSON, learns the server clock and raises the error envelope', async () => {
    const serverDate = new Date(Date.now() + 90_000);
    serverDate.setMilliseconds(0);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      if (url.endsWith('/fail')) {
        return new Response(
          JSON.stringify({
            error: { code: 'deadline_passed', message: 'late', correlationId: 'c' },
          }),
          { status: 409, headers: { date: serverDate.toUTCString() } },
        );
      }
      return new Response(JSON.stringify({ url: 'https://s3.local/signed' }), {
        status: 200,
        headers: { date: serverDate.toUTCString(), 'content-type': 'application/json' },
      });
    });
    const res = await partnerFetch<{ url: string }>('/api/v1/files/f1/download');
    expect(res.url).toBe('https://s3.local/signed');
    expect(calls[0]!.headers.accept).toBe('application/json');
    expect(serverClockKnown()).toBe(true);
    // The device clock is ~90 s behind; serverNow() follows the server.
    expect(Math.abs(serverNow().getTime() - serverDate.getTime())).toBeLessThan(5_000);
    await expect(partnerFetch('/api/v1/fail', { body: {} })).rejects.toMatchObject({
      code: 'deadline_passed',
      status: 409,
    });
    expect(calls[1]!.headers['content-type']).toBe('application/json');
  });
});
