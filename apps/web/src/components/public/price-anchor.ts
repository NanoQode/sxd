import { formatNairaString } from '@simplexd/ui/format';

/**
 * Price anchor presentation. Anchors are editable business data with a basis,
 * minimum scope, exclusions and a publication state. Only a published package
 * shows its figure; a package under business review says so instead of
 * showing an unreviewed number, and nothing is ever fabricated.
 */

export type PriceBasis = 'fixed' | 'from' | 'per_month' | 'percentage' | 'quotation';
export type PackagePublication = 'draft' | 'in_review' | 'published' | 'retired';

export interface PriceAnchorInput {
  priceBasis: PriceBasis;
  /** Integer kobo as a decimal string, or null when the basis has no amount. */
  amountKobo: string | null;
  percentageBps: number | null;
  publicationState: PackagePublication;
}

export const PRICE_REVIEW_LABEL = 'Indicative price under business review';
export const PERCENTAGE_CONDITION = 'agreed basis and signed scope required';

export function basisLabel(basis: PriceBasis): string {
  switch (basis) {
    case 'fixed':
      return 'Fixed fee';
    case 'from':
      return 'Starting price';
    case 'per_month':
      return 'Monthly retainer';
    case 'percentage':
      return 'Percentage of purchase price';
    case 'quotation':
      return 'By quotation';
  }
}

export function formatPercentageBps(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2).replace(/0$/, '')}%`;
}

/**
 * Human label for a price anchor, e.g. "From ₦150,000", "₦75,000 per month",
 * "1.5% of purchase price (agreed basis and signed scope required)",
 * "By quotation". Returns the review label for in_review packages and null for
 * drafts or retired packages (never shown publicly).
 */
export function priceAnchorLabel(input: PriceAnchorInput): string | null {
  if (input.publicationState === 'draft' || input.publicationState === 'retired') return null;
  if (input.publicationState === 'in_review') return PRICE_REVIEW_LABEL;
  switch (input.priceBasis) {
    case 'quotation':
      return 'By quotation';
    case 'percentage':
      return input.percentageBps === null
        ? PRICE_REVIEW_LABEL
        : `${formatPercentageBps(input.percentageBps)} of purchase price (${PERCENTAGE_CONDITION})`;
    case 'per_month':
      return input.amountKobo === null
        ? PRICE_REVIEW_LABEL
        : `${formatNairaString(input.amountKobo)} per month`;
    case 'from':
      return input.amountKobo === null ? PRICE_REVIEW_LABEL : `From ${formatNairaString(input.amountKobo)}`;
    case 'fixed':
      return input.amountKobo === null ? PRICE_REVIEW_LABEL : formatNairaString(input.amountKobo);
  }
}

/** Short status wording next to a price anchor. */
export function priceStatusLabel(state: PackagePublication): string {
  switch (state) {
    case 'published':
      return 'Published anchor';
    case 'in_review':
      return 'Under business review';
    case 'draft':
      return 'Draft';
    case 'retired':
      return 'Retired';
  }
}
