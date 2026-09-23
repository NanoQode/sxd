import { describe, expect, it } from 'vitest';
import {
  breadcrumbJsonLd,
  koboToNairaDecimal,
  organizationJsonLd,
  placeJsonLd,
  serializeJsonLd,
  serviceJsonLd,
  serviceOfferJsonLd,
} from './structured-data';

describe('serializeJsonLd', () => {
  it('escapes characters that could close the script tag', () => {
    const out = serializeJsonLd({ name: '</script><img src=x onerror=alert(1)>' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script\\u003e');
  });
});

describe('serviceOfferJsonLd', () => {
  it('emits offers only for published anchors with an amount', () => {
    expect(
      serviceOfferJsonLd({
        priceBasis: 'from',
        amountKobo: '15000000',
        publicationState: 'in_review',
      }),
    ).toBeNull();
    expect(
      serviceOfferJsonLd({
        priceBasis: 'quotation',
        amountKobo: null,
        publicationState: 'published',
      }),
    ).toBeNull();
    expect(
      serviceOfferJsonLd({
        priceBasis: 'percentage',
        amountKobo: null,
        publicationState: 'published',
      }),
    ).toBeNull();
    const from = serviceOfferJsonLd({
      priceBasis: 'from',
      amountKobo: '15000000',
      publicationState: 'published',
    });
    expect(from).toMatchObject({
      '@type': 'Offer',
      priceCurrency: 'NGN',
      priceSpecification: { minPrice: '150000' },
    });
    const monthly = serviceOfferJsonLd({
      priceBasis: 'per_month',
      amountKobo: '7500000',
      publicationState: 'published',
    });
    expect(monthly).toMatchObject({ priceSpecification: { price: '75000', unitText: 'month' } });
  });

  it('converts kobo strings to naira decimals without float drift', () => {
    expect(koboToNairaDecimal('15000000')).toBe('150000');
    expect(koboToNairaDecimal('1050')).toBe('10.50');
    expect(koboToNairaDecimal('5')).toBe('0.05');
  });
});

describe('graph builders', () => {
  it('never fabricates sameAs, ratings or reviews', () => {
    const org = organizationJsonLd({
      name: 'SimplexD',
      url: 'https://example.test',
      description: 'd',
    });
    expect(org).not.toHaveProperty('sameAs');
    expect(org).not.toHaveProperty('aggregateRating');
    const place = placeJsonLd({
      name: 'Ibadan',
      url: 'https://example.test/locations/ng-ibadan',
      lat: 7.3775,
      lon: 3.9058,
      stateName: 'Oyo',
    });
    expect(place).not.toHaveProperty('aggregateRating');
    expect(place).toMatchObject({
      geo: { latitude: 7.3775, longitude: 3.9058 },
      address: { addressCountry: 'NG' },
    });
    const svc = serviceJsonLd({
      name: 'Due diligence',
      description: 'd',
      url: 'u',
      providerName: 'SimplexD',
      providerUrl: 'p',
      offer: null,
    });
    expect(svc).not.toHaveProperty('offers');
  });

  it('numbers breadcrumb positions from one', () => {
    const crumbs = breadcrumbJsonLd([
      { name: 'Home', url: 'https://example.test/' },
      { name: 'Services', url: 'https://example.test/services' },
    ]);
    expect((crumbs.itemListElement as Array<{ position: number }>).map((i) => i.position)).toEqual([
      1, 2,
    ]);
  });
});
