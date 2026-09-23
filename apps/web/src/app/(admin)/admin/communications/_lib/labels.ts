import type { DeliveryLogItemDto } from '@simplexd/contracts';

/** Plain-language labels shared by the communications pages (client and server safe). */

export const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  in_app: 'In-app',
};

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  accepted: 'Accepted by provider',
  sent: 'Accepted by relay',
  delivered: 'Delivered',
  failed: 'Failed',
  suppressed: 'Not sent (suppressed)',
  bounced: 'Bounced',
  rejected: 'Rejected',
};

export const DELIVERY_STATUS_TONES: Record<
  string,
  'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
> = {
  queued: 'neutral',
  accepted: 'info',
  sent: 'info',
  delivered: 'success',
  failed: 'danger',
  suppressed: 'warning',
  bounced: 'danger',
  rejected: 'danger',
};

export const DELIVERY_CONFIRMATION_LABELS: Record<DeliveryLogItemDto['delivery'], string> = {
  confirmed: 'Delivery confirmed by a provider receipt',
  awaiting_receipt: 'Accepted — waiting for the delivery receipt',
  not_reported:
    'Accepted by the SMTP relay — SMTP does not confirm delivery; only a bounce would change this',
  failed: 'Not delivered',
  not_applicable: 'Not handed to a provider',
};

export const RETRY_BLOCK_LABELS: Record<string, string> = {
  already_retried: 'Already retried — open the linked retry.',
  not_failed: 'Only failed or rejected attempts can be retried.',
  one_time_code: 'Verification codes are never resent; the person requests a new code.',
  in_app: 'In-app notifications do not go through a provider.',
  source_not_retained:
    'The event that produced this message is not retained, so it cannot be re-rendered.',
};

/** Human explanations for common pipeline reasons stored on attempts. */
export function explainReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === 'phone_unverified')
    return 'The number is not verified; SMS only goes to numbers confirmed with a code.';
  if (reason === 'provider_not_configured')
    return 'No active provider configuration for this environment.';
  if (reason === 'preference_disabled') return 'The recipient turned this channel off.';
  if (reason.startsWith('suppressed:')) return `Address is suppressed (${reason.slice(11)}).`;
  if (reason.startsWith('missing_variables'))
    return `Template variable missing: ${reason.split(':')[1]?.trim() ?? ''}`;
  if (reason === 'marketing_consent_required') return 'No marketing opt-in recorded.';
  if (reason === 'transactional_opted_out') return 'The number opted out of SMS.';
  if (reason === 'spend_cap_reached') return 'The daily SMS spend cap was reached.';
  if (reason === 'purpose_disabled') return 'This SMS purpose is switched off in Termii settings.';
  if (reason.startsWith('digest:')) return `Bundled into the ${reason.slice(7)} digest.`;
  if (reason === 'quiet_hours') return 'Deferred until the end of quiet hours.';
  return null;
}

export const SUPPRESSION_KIND_LABELS: Record<string, string> = {
  stop_reply: 'STOP reply',
  hard_bounce: 'Hard bounce',
  complaint: 'Complaint',
  other: 'Other',
};

export const DEV_ADAPTER_LABEL = 'Development adapter — no real message was sent';
