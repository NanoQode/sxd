import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { schema, type DbExecutor } from '@simplexd/db';
import {
  evaluateQuietHours,
  evaluateSendPolicy,
  SMS_PURPOSES,
  type ConsentState,
  type QuietHours,
  type SmsCategory,
  type TermiiSettings,
} from '@simplexd/integrations/sms';
import type { NotificationCategory, NotificationChannel, ResolvedRecipient } from './types';

/**
 * Per-recipient, per-channel send policy (brief §13/§14):
 *
 * - suppressions (bounce, complaint, STOP, invalid address) block a channel
 *   for every category, including security;
 * - SMS goes only to verified numbers (`phone_unverified` otherwise), except
 *   the verification code itself and explicit staff test sends;
 * - security messages otherwise always send: no preference, quiet hours or
 *   digest applies;
 * - the preference matrix (channel × category) decides the rest; marketing
 *   defaults to off and SMS defaults to security + transactional only;
 * - a digest preference moves the item to the next digest instead of sending;
 * - quiet hours in the recipient's time zone defer non-security email/SMS to
 *   the end of the window;
 * - SMS additionally needs consent (marketing opt-in, no transactional
 *   opt-out), an enabled purpose and headroom under the daily spend cap.
 */

export type PolicyAction = 'send' | 'suppress' | 'defer' | 'digest';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  deferUntil?: Date;
  digest?: 'daily' | 'weekly';
}

export interface RecipientPolicyFacts {
  preferences: Array<typeof schema.notificationPreferences.$inferSelect>;
  /** Suppression reasons keyed by `${channel}:${address}`. */
  suppressions: Map<string, string>;
  consents: { transactional: ConsentState; marketing: ConsentState; security: ConsentState };
  /** Business-wide default quiet hours from `settings` (`notifications.quiet_hours`). */
  quietDefault: { start: string; end: string } | null;
  /** SMS spend today (kobo) for the cap check. */
  smsSpentTodayKobo: number;
}

export function defaultPreferenceEnabled(
  channel: NotificationChannel,
  category: NotificationCategory,
): boolean {
  if (category === 'security') return true;
  if (category === 'marketing') return false;
  if (channel === 'sms') return category === 'transactional';
  return true;
}

export function smsCategoryFor(category: NotificationCategory): SmsCategory {
  if (category === 'security') return 'security';
  if (category === 'marketing') return 'marketing';
  return 'transactional';
}

export async function loadPolicyFacts(
  tx: DbExecutor,
  recipient: ResolvedRecipient,
  now: Date,
): Promise<RecipientPolicyFacts> {
  const preferences = recipient.userId
    ? await tx
        .select()
        .from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, recipient.userId))
    : [];
  const addresses: Array<{ channel: 'email' | 'sms'; address: string }> = [];
  if (recipient.email) addresses.push({ channel: 'email', address: recipient.email.toLowerCase() });
  if (recipient.phoneE164) addresses.push({ channel: 'sms', address: recipient.phoneE164 });
  const suppressions = new Map<string, string>();
  if (addresses.length > 0) {
    const rows = await tx
      .select()
      .from(schema.suppressions)
      .where(
        inArray(
          schema.suppressions.address,
          addresses.map((a) => a.address),
        ),
      );
    for (const row of rows) suppressions.set(`${row.channel}:${row.address}`, row.reason);
  }
  const consents: RecipientPolicyFacts['consents'] = {
    transactional: 'unknown',
    marketing: recipient.marketingConsentAt ? 'opted_in' : 'unknown',
    security: 'unknown',
  };
  if (recipient.phoneE164) {
    const rows = await tx
      .select()
      .from(schema.smsConsents)
      .where(eq(schema.smsConsents.phoneE164, recipient.phoneE164))
      .orderBy(desc(schema.smsConsents.recordedAt));
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.category)) continue;
      seen.add(row.category);
      const key = smsCategoryFor(row.category);
      consents[key] = row.status;
    }
  }
  const [setting] = await tx
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'notifications.quiet_hours'));
  const quietRaw = setting?.value as { start?: string; end?: string } | undefined;
  const quietDefault =
    quietRaw?.start && quietRaw.end ? { start: quietRaw.start, end: quietRaw.end } : null;
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [spend] = await tx
    .select({
      total: sql<string>`coalesce(sum(${schema.deliveryAttempts.estimatedCostKobo}), 0)::text`,
    })
    .from(schema.deliveryAttempts)
    .where(
      and(
        eq(schema.deliveryAttempts.channel, 'sms'),
        inArray(schema.deliveryAttempts.status, ['accepted', 'sent', 'delivered']),
        gte(schema.deliveryAttempts.queuedAt, dayStart),
      ),
    );
  return {
    preferences,
    suppressions,
    consents,
    quietDefault,
    smsSpentTodayKobo: Number(spend?.total ?? 0),
  };
}

export function quietHoursFor(
  recipient: ResolvedRecipient,
  facts: RecipientPolicyFacts,
): QuietHours | null {
  const explicit = facts.preferences.find((p) => p.quietHoursStart && p.quietHoursEnd);
  if (explicit) {
    return {
      start: explicit.quietHoursStart!,
      end: explicit.quietHoursEnd!,
      timeZone: explicit.timeZone ?? recipient.timeZone,
    };
  }
  if (facts.preferences.length === 0 && facts.quietDefault) {
    return { ...facts.quietDefault, timeZone: recipient.timeZone };
  }
  return null;
}

export interface EvaluatePolicyInput {
  channel: NotificationChannel;
  category: NotificationCategory;
  templateKey: string;
  recipient: ResolvedRecipient;
  facts: RecipientPolicyFacts;
  now: Date;
  /** Termii settings when a real configuration is active (purposes, spend cap, unit cost). */
  smsSettings?: TermiiSettings | null;
  estimatedCostKobo?: number;
  ignorePreferences?: boolean;
  /** Verification codes and staff test sends may go to a number not yet verified. */
  allowUnverifiedPhone?: boolean;
}

export function evaluateChannelPolicy(input: EvaluatePolicyInput): PolicyDecision {
  const { channel, category, recipient, facts } = input;
  const address =
    channel === 'email'
      ? recipient.email?.toLowerCase()
      : channel === 'sms'
        ? recipient.phoneE164
        : null;
  if (channel !== 'in_app') {
    if (!address) return { action: 'suppress', reason: 'no_address' };
    const suppressed = facts.suppressions.get(`${channel}:${address}`);
    if (suppressed) return { action: 'suppress', reason: `suppressed:${suppressed}` };
    // SMS only reaches numbers confirmed with a one-time code (portal settings).
    if (channel === 'sms' && !recipient.phoneVerified && !input.allowUnverifiedPhone) {
      return { action: 'suppress', reason: 'phone_unverified' };
    }
  } else if (!recipient.userId) {
    return { action: 'suppress', reason: 'no_user' };
  }

  if (category !== 'security' && !input.ignorePreferences) {
    const pref = facts.preferences.find((p) => p.channel === channel && p.category === category);
    const enabled = pref ? pref.enabled : defaultPreferenceEnabled(channel, category);
    if (!enabled) return { action: 'suppress', reason: 'preference_disabled' };
    if (pref && pref.digest !== 'none' && channel !== 'in_app') {
      return { action: 'digest', reason: `digest:${pref.digest}`, digest: pref.digest };
    }
  }

  if (channel === 'sms') {
    const purpose = input.templateKey;
    const purposeKnown = (SMS_PURPOSES as readonly string[]).includes(purpose);
    const purposeEnabled = input.smsSettings
      ? !purposeKnown || input.smsSettings.enabledPurposes.includes(purpose as never)
      : true;
    const decision = evaluateSendPolicy({
      category: smsCategoryFor(category),
      consent: { transactional: facts.consents.transactional, marketing: facts.consents.marketing },
      suppressed: false,
      quietHours: null,
      now: input.now,
      purposeEnabled,
      spend: {
        sentTodayKobo: facts.smsSpentTodayKobo,
        dailyCapKobo: input.smsSettings?.dailySpendCapKobo ?? null,
        estimatedCostKobo: input.estimatedCostKobo ?? 0,
      },
    });
    if (!decision.allowed) return { action: 'suppress', reason: decision.reason };
  }

  if (category !== 'security' && channel !== 'in_app') {
    const quiet = quietHoursFor(recipient, facts);
    if (quiet) {
      const evaluation = evaluateQuietHours(quiet, input.now);
      if (evaluation.valid && evaluation.inQuietHours && evaluation.resumeAt) {
        return { action: 'defer', reason: 'quiet_hours', deferUntil: evaluation.resumeAt };
      }
    }
  }
  return { action: 'send', reason: 'ok' };
}
