import { DateTime } from 'luxon';
import type { SmsCategory } from './types';

/**
 * Pure send-policy evaluation. The worker calls this before every SMS send
 * with the consent, suppression, preference and spend facts it loaded from
 * the database; nothing here performs I/O.
 *
 * Rules (brief §13/§14):
 * - suppression (opt-out/complaint/invalid number) and a disabled purpose
 *   block everything, including security messages;
 * - security messages otherwise always go (no quiet hours, no spend cap);
 * - transactional messages go unless the person explicitly opted out of
 *   transactional SMS, and count against the daily spend cap;
 * - marketing requires an explicit opt-in, respects quiet hours by deferring
 *   to the end of the quiet window, and counts against the spend cap.
 */

export type ConsentState = 'opted_in' | 'opted_out' | 'unknown';

export interface QuietHours {
  /** `HH:mm` (a `time` column value such as `21:00:00` is accepted too). */
  start: string;
  end: string;
  /** IANA zone, e.g. `Africa/Lagos`. */
  timeZone: string;
}

export interface SendPolicyInput {
  category: SmsCategory;
  consent: { transactional: ConsentState; marketing: ConsentState };
  suppressed: boolean;
  quietHours: QuietHours | null;
  now: Date;
  purposeEnabled: boolean;
  spend: {
    sentTodayKobo: number;
    dailyCapKobo: number | null;
    /** Cost of the message being evaluated; defaults to 0. */
    estimatedCostKobo?: number;
  };
}

export type SendPolicyReason =
  | 'ok'
  | 'suppressed'
  | 'purpose_disabled'
  | 'marketing_consent_required'
  | 'marketing_opted_out'
  | 'transactional_opted_out'
  | 'quiet_hours'
  | 'invalid_quiet_hours'
  | 'spend_cap_reached';

export interface SendPolicyDecision {
  allowed: boolean;
  reason: SendPolicyReason;
  /** Set when the message should be re-queued rather than dropped. */
  deferUntil?: Date;
}

function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface QuietHoursEvaluation {
  valid: boolean;
  inQuietHours: boolean;
  /** When the quiet window ends (next allowed send moment); null when not in quiet hours. */
  resumeAt: Date | null;
}

export function evaluateQuietHours(quietHours: QuietHours, now: Date): QuietHoursEvaluation {
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  const local = DateTime.fromJSDate(now, { zone: quietHours.timeZone });
  if (start === null || end === null || !local.isValid) {
    return { valid: false, inQuietHours: false, resumeAt: null };
  }
  if (start === end) return { valid: true, inQuietHours: false, resumeAt: null };
  const nowMinutes = local.hour * 60 + local.minute;
  const endToday = local.set({
    hour: Math.floor(end / 60),
    minute: end % 60,
    second: 0,
    millisecond: 0,
  });
  if (start < end) {
    const inside = nowMinutes >= start && nowMinutes < end;
    return { valid: true, inQuietHours: inside, resumeAt: inside ? endToday.toJSDate() : null };
  }
  // Overnight window, e.g. 21:00 → 08:00.
  if (nowMinutes >= start) {
    return { valid: true, inQuietHours: true, resumeAt: endToday.plus({ days: 1 }).toJSDate() };
  }
  if (nowMinutes < end) {
    return { valid: true, inQuietHours: true, resumeAt: endToday.toJSDate() };
  }
  return { valid: true, inQuietHours: false, resumeAt: null };
}

function spendCapReached(spend: SendPolicyInput['spend']): boolean {
  if (spend.dailyCapKobo === null || spend.dailyCapKobo === undefined) return false;
  const estimated = Math.max(0, spend.estimatedCostKobo ?? 0);
  return (
    spend.sentTodayKobo >= spend.dailyCapKobo ||
    spend.sentTodayKobo + estimated > spend.dailyCapKobo
  );
}

export function evaluateSendPolicy(input: SendPolicyInput): SendPolicyDecision {
  if (input.suppressed) return { allowed: false, reason: 'suppressed' };
  if (!input.purposeEnabled) return { allowed: false, reason: 'purpose_disabled' };

  if (input.category === 'security') return { allowed: true, reason: 'ok' };

  if (input.category === 'transactional') {
    if (input.consent.transactional === 'opted_out') {
      return { allowed: false, reason: 'transactional_opted_out' };
    }
    if (spendCapReached(input.spend)) return { allowed: false, reason: 'spend_cap_reached' };
    return { allowed: true, reason: 'ok' };
  }

  // marketing
  if (input.consent.marketing === 'opted_out') {
    return { allowed: false, reason: 'marketing_opted_out' };
  }
  if (input.consent.marketing !== 'opted_in') {
    return { allowed: false, reason: 'marketing_consent_required' };
  }
  if (spendCapReached(input.spend)) return { allowed: false, reason: 'spend_cap_reached' };
  if (input.quietHours) {
    const quiet = evaluateQuietHours(input.quietHours, input.now);
    if (!quiet.valid) return { allowed: false, reason: 'invalid_quiet_hours' };
    if (quiet.inQuietHours && quiet.resumeAt) {
      return { allowed: false, reason: 'quiet_hours', deferUntil: quiet.resumeAt };
    }
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * Inbound keyword handling for opt-out/opt-in replies. Returns the consent
 * change the app should record (across all campaigns) or null.
 */
export function classifyInboundKeyword(text: string | null | undefined): 'opt_out' | 'opt_in' | null {
  if (!text) return null;
  const word = text.trim().toUpperCase().split(/\s+/)[0] ?? '';
  if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT-OUT'].includes(word)) {
    return 'opt_out';
  }
  if (['START', 'UNSTOP', 'SUBSCRIBE', 'YES', 'OPTIN', 'OPT-IN'].includes(word)) return 'opt_in';
  return null;
}
