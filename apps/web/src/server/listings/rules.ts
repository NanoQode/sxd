import {
  VERIFICATION_CHECK_LABELS,
  verificationCheckItemSchema,
  verificationCheckOutcomeSchema,
  type ListingOfferActionName,
  type ListingOfferStatus,
  type ListingStatus,
  type VerificationCheckDto,
} from '@simplexd/contracts';

/**
 * Pure listing rules shared by the owner, moderation, public, offer and job
 * modules (no I/O, unit-testable). The worker's expiry handler
 * (apps/worker/src/handlers/listings.ts) follows the same rules.
 */

/**
 * Availability window: a published listing is shown for this many days after
 * publication or the owner's last availability confirmation, then expires
 * until the owner re-confirms. Configurable here only (one constant).
 */
export const LISTING_AVAILABILITY_WINDOW_DAYS = 90;

/** Owners are reminded (and may re-confirm) from this many days before expiry. */
export const LISTING_RECONFIRM_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

export function availabilityExpiry(from: Date, days = LISTING_AVAILABILITY_WINDOW_DAYS): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** A published listing whose window has passed reads as expired before the job records it. */
export function effectiveListingStatus(
  status: ListingStatus,
  expiresAt: Date | null,
  now: Date = new Date(),
): ListingStatus {
  if (status === 'published' && expiresAt && expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return status;
}

/** True when the listing may appear on the public site right now. */
export function isPubliclyVisible(
  row: {
    status: ListingStatus;
    publishedVersion: number | null;
    duplicateOfListingId: string | null;
    expiresAt: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (row.duplicateOfListingId) return false;
  if (row.publishedVersion === null) return false;
  // A published listing stays live on its approved revision while newer changes are reviewed.
  if (row.status !== 'published' && row.status !== 'in_moderation') return false;
  return !row.expiresAt || row.expiresAt.getTime() > now.getTime();
}

/** Lower-case URL slug of a place name (states have no stored slug). */
export function placeSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function listingSlugBase(title: string): string {
  const base = placeSlug(title).slice(0, 60).replace(/-+$/g, '');
  return base.length >= 3 ? base : 'listing';
}

/* ---------------------------------------------------------------------- */
/* Verification scope                                                      */
/* ---------------------------------------------------------------------- */

/** Stored shape: the schema's VerificationScope check plus outcome and actor id. */
export interface StoredCheck {
  item: string;
  checkedBy: string;
  checkedAt: string;
  expiresAt?: string;
  result: string;
  outcome?: string;
  checkedByUserId?: string;
  recordedAt?: string;
}

export interface StoredScope {
  checks: StoredCheck[];
  summary?: string;
}

export function readScope(value: unknown): StoredScope {
  if (!value || typeof value !== 'object') return { checks: [] };
  const v = value as { checks?: unknown; summary?: unknown };
  const checks = Array.isArray(v.checks)
    ? v.checks.filter(
        (c): c is StoredCheck =>
          Boolean(c) &&
          typeof c === 'object' &&
          typeof (c as StoredCheck).item === 'string' &&
          typeof (c as StoredCheck).checkedAt === 'string',
      )
    : [];
  return { checks, summary: typeof v.summary === 'string' ? v.summary : undefined };
}

export function checkLabel(item: string): string {
  const parsed = verificationCheckItemSchema.safeParse(item);
  return parsed.success ? VERIFICATION_CHECK_LABELS[parsed.data] : item;
}

/** Public/API shape of a stored check: the actor's user id is never exposed. */
export function toCheckDto(check: StoredCheck): VerificationCheckDto {
  const outcome = verificationCheckOutcomeSchema.safeParse(check.outcome);
  return {
    item: check.item,
    label: checkLabel(check.item),
    outcome: outcome.success ? outcome.data : null,
    result: check.result ?? '',
    checkedBy: check.checkedBy ?? 'SimplexD staff',
    checkedAt: check.checkedAt,
    expiresAt: check.expiresAt ?? null,
  };
}

export function isCheckCurrent(
  check: { expiresAt?: string | null },
  now: Date = new Date(),
): boolean {
  return !check.expiresAt || new Date(check.expiresAt).getTime() > now.getTime();
}

/* ---------------------------------------------------------------------- */
/* Offers                                                                  */
/* ---------------------------------------------------------------------- */

export type OfferSide = 'buyer' | 'owner';

export function effectiveOfferStatus(
  status: ListingOfferStatus,
  expiresAt: Date | null,
  now: Date = new Date(),
): ListingOfferStatus {
  if (
    (status === 'submitted' || status === 'countered') &&
    expiresAt &&
    expiresAt.getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  return status;
}

/**
 * Whose move it is and what each side may do:
 *  - `submitted` (the buyer's figure is on the table): the owner may counter,
 *    accept or reject; the buyer may withdraw;
 *  - `countered` (the owner's figure is on the table): the buyer may counter,
 *    accept or withdraw; the owner may reject (end the negotiation).
 * Terminal and effectively expired offers allow nothing.
 */
export function allowedOfferActions(
  status: ListingOfferStatus,
  side: OfferSide,
): ListingOfferActionName[] {
  if (status === 'submitted') {
    return side === 'owner' ? ['counter', 'accept', 'reject'] : ['withdraw'];
  }
  if (status === 'countered') {
    return side === 'buyer' ? ['counter', 'accept', 'withdraw'] : ['reject'];
  }
  return [];
}

export function nextOfferStatus(
  action: ListingOfferActionName,
  side: OfferSide,
): ListingOfferStatus {
  switch (action) {
    case 'counter':
      return side === 'owner' ? 'countered' : 'submitted';
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
    case 'withdraw':
      return 'withdrawn';
  }
}

export const OFFER_ACTION_LOG: Record<
  ListingOfferActionName,
  'countered' | 'accepted' | 'rejected' | 'withdrawn'
> = {
  counter: 'countered',
  accept: 'accepted',
  reject: 'rejected',
  withdraw: 'withdrawn',
};

export function readNegotiationLog(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
    : [];
}

export function readConditions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
}
