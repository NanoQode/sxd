import { describe, expect, it } from 'vitest';
import { CORE_SERVICE_NAV, isActivePath } from './nav-data';
import { searchMarkets, searchPages, searchServices } from './search';

describe('searchServices', () => {
  it('ranks name matches above hint matches and ignores empty queries', () => {
    expect(searchServices(CORE_SERVICE_NAV, '   ')).toEqual([]);
    const results = searchServices(CORE_SERVICE_NAV, 'due');
    expect(results[0]).toMatchObject({
      group: 'services',
      href: '/services/due-diligence',
      title: 'Due diligence',
    });
    const byHint = searchServices(CORE_SERVICE_NAV, 'drawings');
    expect(byHint.map((r) => r.href)).toContain('/services/architectural-services');
  });

  it('labels planned services as inquiry only', () => {
    const results = searchServices(
      [
        {
          slug: 'quantity-surveying',
          name: 'Quantity surveying',
          hint: 'BOQ',
          category: 'expansion',
        },
      ],
      'quantity',
    );
    expect(results[0]?.subtitle).toBe('Planned service · inquiry only');
  });
});

describe('searchMarkets', () => {
  const markets = [
    { slug: 'ng-sagamu', name: 'Sagamu', stateName: 'Ogun', aliases: ['Shagamu'] },
    { slug: 'ng-ibadan', name: 'Ibadan', stateName: 'Oyo' },
    { slug: 'ng-ogbomoso', name: 'Ogbomoso', stateName: 'Oyo' },
  ];

  it('matches aliases and state names', () => {
    expect(searchMarkets(markets, 'shagamu').map((r) => r.href)).toEqual(['/locations/ng-sagamu']);
    expect(
      searchMarkets(markets, 'oyo')
        .map((r) => r.title)
        .sort(),
    ).toEqual(['Ibadan', 'Ogbomoso']);
  });

  it('prefers exact and prefix matches', () => {
    expect(searchMarkets(markets, 'ibadan')[0]?.title).toBe('Ibadan');
  });
});

describe('searchPages and paths', () => {
  it('finds static pages by keyword', () => {
    expect(searchPages('privacy').map((r) => r.href)).toContain('/policies/privacy');
    expect(searchPages('consultation')[0]?.href).toBe('/book');
  });

  it('treats nested routes as active', () => {
    expect(isActivePath('/services/due-diligence', '/services')).toBe(true);
    expect(isActivePath('/servicesx', '/services')).toBe(false);
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/about', '/')).toBe(false);
  });
});
