import { describe, expect, it } from 'vitest';
import { basisLabel, formatPercentageBps, priceAnchorLabel, PRICE_REVIEW_LABEL } from './price-anchor';

describe('priceAnchorLabel', () => {
  it('renders the four published bases from the brief', () => {
    expect(
      priceAnchorLabel({ priceBasis: 'from', amountKobo: '15000000', percentageBps: null, publicationState: 'published' }),
    ).toBe('From ₦150,000');
    expect(
      priceAnchorLabel({ priceBasis: 'per_month', amountKobo: '7500000', percentageBps: null, publicationState: 'published' }),
    ).toBe('₦75,000 per month');
    expect(
      priceAnchorLabel({ priceBasis: 'percentage', amountKobo: null, percentageBps: 150, publicationState: 'published' }),
    ).toBe('1.5% of purchase price (agreed basis and signed scope required)');
    expect(
      priceAnchorLabel({ priceBasis: 'quotation', amountKobo: null, percentageBps: null, publicationState: 'published' }),
    ).toBe('By quotation');
    expect(
      priceAnchorLabel({ priceBasis: 'fixed', amountKobo: '5000000', percentageBps: null, publicationState: 'published' }),
    ).toBe('₦50,000');
  });

  it('never shows a figure for a package under business review', () => {
    expect(
      priceAnchorLabel({ priceBasis: 'from', amountKobo: '15000000', percentageBps: null, publicationState: 'in_review' }),
    ).toBe(PRICE_REVIEW_LABEL);
    expect(
      priceAnchorLabel({ priceBasis: 'percentage', amountKobo: null, percentageBps: 150, publicationState: 'in_review' }),
    ).toBe(PRICE_REVIEW_LABEL);
  });

  it('hides drafts and retired packages entirely', () => {
    expect(
      priceAnchorLabel({ priceBasis: 'from', amountKobo: '15000000', percentageBps: null, publicationState: 'draft' }),
    ).toBeNull();
    expect(
      priceAnchorLabel({ priceBasis: 'quotation', amountKobo: null, percentageBps: null, publicationState: 'retired' }),
    ).toBeNull();
  });

  it('falls back to the review label instead of fabricating a missing amount', () => {
    expect(
      priceAnchorLabel({ priceBasis: 'from', amountKobo: null, percentageBps: null, publicationState: 'published' }),
    ).toBe(PRICE_REVIEW_LABEL);
    expect(
      priceAnchorLabel({ priceBasis: 'percentage', amountKobo: null, percentageBps: null, publicationState: 'published' }),
    ).toBe(PRICE_REVIEW_LABEL);
  });
});

describe('helpers', () => {
  it('formats basis points as a percentage without trailing zeros', () => {
    expect(formatPercentageBps(150)).toBe('1.5%');
    expect(formatPercentageBps(200)).toBe('2%');
    expect(formatPercentageBps(125)).toBe('1.25%');
  });

  it('labels every basis', () => {
    expect(basisLabel('percentage')).toBe('Percentage of purchase price');
    expect(basisLabel('quotation')).toBe('By quotation');
    expect(basisLabel('per_month')).toBe('Monthly retainer');
  });
});
