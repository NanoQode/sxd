import {
  LISTING_PRICE_BASIS_LABELS,
  LISTING_TENURE_LABELS,
  listingPriceBasisSchema,
  listingTenureSchema,
  type PublicListingDto,
} from '@simplexd/contracts';
import { formatDateLabel, formatNairaString } from '@simplexd/ui';

/** Presentation helpers for listings shared by the public, portal and admin pages. */

export function priceLabel(l: { priceKobo: string | null; priceBasis: string | null }): string {
  if (!l.priceKobo) return 'Price on request';
  const basis = listingPriceBasisSchema.safeParse(l.priceBasis);
  return `${formatNairaString(l.priceKobo)}${basis.success ? ` ${LISTING_PRICE_BASIS_LABELS[basis.data]}` : ''}`;
}

export function tenureLabel(tenure: string | null): string {
  const parsed = listingTenureSchema.safeParse(tenure);
  return parsed.success ? LISTING_TENURE_LABELS[parsed.data] : 'Not stated';
}

export function availabilityLabel(availability: string | null): string {
  if (!availability) return 'Not stated';
  if (availability === 'now') return 'Available now';
  return `Available from ${formatDateLabel(`${availability}T00:00:00Z`)}`;
}

export function locationLabel(l: PublicListingDto['location']): string {
  const parts = [l.neighborhoodName, l.marketName, l.stateName].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Location not published';
}

export const PRECISION_COPY: Record<PublicListingDto['location']['precision'], string> = {
  state: 'State only: the market, neighbourhood and coordinates are withheld.',
  market: 'Market level: the neighbourhood and coordinates are withheld.',
  neighborhood: 'Neighbourhood level: coordinates are withheld.',
  exact: 'Exact coordinates, published at the owner’s request with staff approval.',
};
