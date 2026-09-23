import { describe, expect, it } from 'vitest';
import { classifyInboundKeyword, evaluateSendPolicy, type SendPolicyInput } from './policy';

const base = (over: Partial<SendPolicyInput> = {}): SendPolicyInput => ({
  category: 'transactional',
  consent: { transactional: 'unknown', marketing: 'unknown' },
  suppressed: false,
  quietHours: null,
  now: new Date('2026-09-23T12:00:00Z'),
  purposeEnabled: true,
  spend: { sentTodayKobo: 0, dailyCapKobo: null },
  ...over,
});

const lagosNight = { start: '21:00', end: '08:00', timeZone: 'Africa/Lagos' };

describe('sms send policy', () => {
  it('blocks marketing without an explicit opt-in', () => {
    expect(evaluateSendPolicy(base({ category: 'marketing' }))).toEqual({
      allowed: false,
      reason: 'marketing_consent_required',
    });
    expect(
      evaluateSendPolicy(
        base({ category: 'marketing', consent: { transactional: 'unknown', marketing: 'opted_out' } }),
      ),
    ).toEqual({ allowed: false, reason: 'marketing_opted_out' });
  });

  it('defers marketing inside quiet hours to the end of the window', () => {
    const optedIn = { transactional: 'unknown', marketing: 'opted_in' } as const;
    // 22:30 WAT → resume next morning 08:00 WAT (07:00Z)
    const late = evaluateSendPolicy(
      base({
        category: 'marketing',
        consent: optedIn,
        quietHours: lagosNight,
        now: new Date('2026-09-23T21:30:00Z'),
      }),
    );
    expect(late).toMatchObject({ allowed: false, reason: 'quiet_hours' });
    expect(late.deferUntil?.toISOString()).toBe('2026-09-24T07:00:00.000Z');
    // 03:00 WAT → resume the same morning
    const early = evaluateSendPolicy(
      base({
        category: 'marketing',
        consent: optedIn,
        quietHours: lagosNight,
        now: new Date('2026-09-24T02:00:00Z'),
      }),
    );
    expect(early.deferUntil?.toISOString()).toBe('2026-09-24T07:00:00.000Z');
    // midday → allowed
    expect(
      evaluateSendPolicy(
        base({
          category: 'marketing',
          consent: optedIn,
          quietHours: lagosNight,
          now: new Date('2026-09-23T11:00:00Z'),
        }),
      ),
    ).toEqual({ allowed: true, reason: 'ok' });
    // same-day window 12:00–14:00 WAT at 13:00 WAT
    const sameDay = evaluateSendPolicy(
      base({
        category: 'marketing',
        consent: optedIn,
        quietHours: { start: '12:00:00', end: '14:00:00', timeZone: 'Africa/Lagos' },
        now: new Date('2026-09-23T12:00:00Z'),
      }),
    );
    expect(sameDay.deferUntil?.toISOString()).toBe('2026-09-23T13:00:00.000Z');
    // quiet hours never apply to transactional messages
    expect(
      evaluateSendPolicy(base({ quietHours: lagosNight, now: new Date('2026-09-23T21:30:00Z') }))
        .allowed,
    ).toBe(true);
  });

  it('applies the daily spend cap to transactional and marketing but not security', () => {
    expect(evaluateSendPolicy(base({ spend: { sentTodayKobo: 1000, dailyCapKobo: 1000 } }))).toEqual({
      allowed: false,
      reason: 'spend_cap_reached',
    });
    expect(
      evaluateSendPolicy(
        base({ spend: { sentTodayKobo: 900, dailyCapKobo: 1000, estimatedCostKobo: 200 } }),
      ).reason,
    ).toBe('spend_cap_reached');
    expect(
      evaluateSendPolicy(
        base({ spend: { sentTodayKobo: 900, dailyCapKobo: 1000, estimatedCostKobo: 100 } }),
      ).allowed,
    ).toBe(true);
    expect(
      evaluateSendPolicy(
        base({ category: 'security', spend: { sentTodayKobo: 5000, dailyCapKobo: 1000 } }),
      ),
    ).toEqual({ allowed: true, reason: 'ok' });
    expect(
      evaluateSendPolicy(
        base({
          category: 'marketing',
          consent: { transactional: 'unknown', marketing: 'opted_in' },
          spend: { sentTodayKobo: 1000, dailyCapKobo: 1000 },
        }),
      ).reason,
    ).toBe('spend_cap_reached');
  });

  it('suppression and a disabled purpose block everything, including security', () => {
    expect(evaluateSendPolicy(base({ category: 'security', suppressed: true }))).toEqual({
      allowed: false,
      reason: 'suppressed',
    });
    expect(evaluateSendPolicy(base({ category: 'security', purposeEnabled: false }))).toEqual({
      allowed: false,
      reason: 'purpose_disabled',
    });
  });

  it('respects an explicit transactional opt-out but allows unknown consent', () => {
    expect(
      evaluateSendPolicy(base({ consent: { transactional: 'opted_out', marketing: 'unknown' } })),
    ).toEqual({ allowed: false, reason: 'transactional_opted_out' });
    expect(evaluateSendPolicy(base())).toEqual({ allowed: true, reason: 'ok' });
  });

  it('fails closed on an invalid quiet-hours configuration', () => {
    expect(
      evaluateSendPolicy(
        base({
          category: 'marketing',
          consent: { transactional: 'unknown', marketing: 'opted_in' },
          quietHours: { start: '21:00', end: '08:00', timeZone: 'Nowhere/Zone' },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'invalid_quiet_hours' });
  });

  it('classifies inbound opt-out and opt-in keywords', () => {
    expect(classifyInboundKeyword('STOP')).toBe('opt_out');
    expect(classifyInboundKeyword(' stop please ')).toBe('opt_out');
    expect(classifyInboundKeyword('start')).toBe('opt_in');
    expect(classifyInboundKeyword('hello')).toBeNull();
  });
});
