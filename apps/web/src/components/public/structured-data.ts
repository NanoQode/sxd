/**
 * Structured data helpers. Only accurate data is emitted: no ratings, no
 * fabricated sameAs profiles, and Service offers only when a price anchor is
 * published. Output is escaped so it can never break out of the script tag.
 */

export type JsonLdObject = Record<string, unknown>;
type JsonLd = JsonLdObject;

export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data)
    .replace(/[<]/g, '\\u003c')
    .replace(/[>]/g, '\\u003e')
    .replace(/[&]/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function organizationJsonLd(input: {
  name: string;
  url: string;
  description: string;
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    url: input.url,
    description: input.description,
    areaServed: { '@type': 'Country', name: 'Nigeria' },
  };
}

export function websiteJsonLd(input: { name: string; url: string }): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: input.name,
    url: input.url,
  };
}

export function breadcrumbJsonLd(items: Array<{ name: string; url: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export interface ServiceOfferInput {
  priceBasis: 'fixed' | 'from' | 'per_month' | 'percentage' | 'quotation';
  /** Integer kobo as a string. */
  amountKobo: string | null;
  publicationState: 'draft' | 'in_review' | 'published' | 'retired';
}

function koboToNairaDecimal(amountKobo: string): string {
  const negative = amountKobo.startsWith('-');
  const digits = amountKobo.replace(/^-/, '').padStart(3, '0');
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  return `${negative ? '-' : ''}${whole}${frac === '00' ? '' : `.${frac}`}`;
}

/**
 * Offer block for a service. Returns null unless the anchor is published and
 * expressible: percentage and quotation bases have no fixed price to state.
 */
export function serviceOfferJsonLd(pkg: ServiceOfferInput): JsonLd | null {
  if (pkg.publicationState !== 'published' || pkg.amountKobo === null) return null;
  const price = koboToNairaDecimal(pkg.amountKobo);
  switch (pkg.priceBasis) {
    case 'fixed':
      return { '@type': 'Offer', priceCurrency: 'NGN', price };
    case 'from':
      return {
        '@type': 'Offer',
        priceCurrency: 'NGN',
        priceSpecification: {
          '@type': 'PriceSpecification',
          minPrice: price,
          priceCurrency: 'NGN',
        },
      };
    case 'per_month':
      return {
        '@type': 'Offer',
        priceCurrency: 'NGN',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price,
          priceCurrency: 'NGN',
          unitText: 'month',
        },
      };
    default:
      return null;
  }
}

export function serviceJsonLd(input: {
  name: string;
  description: string;
  url: string;
  providerName: string;
  providerUrl: string;
  offer: JsonLd | null;
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: input.name,
    description: input.description,
    url: input.url,
    areaServed: { '@type': 'Country', name: 'Nigeria' },
    provider: { '@type': 'Organization', name: input.providerName, url: input.providerUrl },
    ...(input.offer ? { offers: input.offer } : {}),
  };
}

export function placeJsonLd(input: {
  name: string;
  url: string;
  lat: number;
  lon: number;
  stateName: string;
  description?: string;
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: input.name,
    url: input.url,
    ...(input.description ? { description: input.description } : {}),
    geo: { '@type': 'GeoCoordinates', latitude: input.lat, longitude: input.lon },
    address: { '@type': 'PostalAddress', addressRegion: input.stateName, addressCountry: 'NG' },
  };
}

export function faqJsonLd(items: Array<{ question: string; answerText: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.question,
      acceptedAnswer: { '@type': 'Answer', text: i.answerText },
    })),
  };
}

export function listingJsonLd(input: {
  name: string;
  url: string;
  datePosted: string | null;
  priceNairaDecimal: string | null;
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: input.name,
    url: input.url,
    ...(input.datePosted ? { datePosted: input.datePosted } : {}),
    ...(input.priceNairaDecimal
      ? { offers: { '@type': 'Offer', price: input.priceNairaDecimal, priceCurrency: 'NGN' } }
      : {}),
  };
}

export { koboToNairaDecimal };
