import { SEARCHABLE_PAGES, type NavServiceItem } from './nav-data';

/** Client-side ranking for the header search dialog. Pure and unit-tested. */

export interface SearchResult {
  group: 'services' | 'locations' | 'pages';
  href: string;
  title: string;
  subtitle?: string;
}

export interface SearchableMarket {
  slug: string;
  name: string;
  stateName: string;
  aliases?: string[];
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function scoreText(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  if (h === needle) return 3;
  if (h.startsWith(needle)) return 2;
  if (h.includes(needle)) return 1;
  return 0;
}

export function searchServices(
  services: Array<NavServiceItem & { category?: 'core' | 'expansion' }>,
  query: string,
  limit = 6,
): SearchResult[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return services
    .map((s) => ({ s, score: Math.max(scoreText(s.name, q), scoreText(s.hint, q) > 0 ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map(({ s }) => ({
      group: 'services' as const,
      href: `/services/${s.slug}`,
      title: s.name,
      subtitle: s.category === 'expansion' ? 'Planned service · inquiry only' : s.hint,
    }));
}

export function searchMarkets(
  markets: SearchableMarket[],
  query: string,
  limit = 8,
): SearchResult[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return markets
    .map((m) => ({
      m,
      score: Math.max(
        scoreText(m.name, q),
        scoreText(m.stateName, q) > 0 ? 1 : 0,
        ...(m.aliases ?? []).map((a) => scoreText(a, q)),
      ),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name))
    .slice(0, limit)
    .map(({ m }) => ({
      group: 'locations' as const,
      href: `/locations/${m.slug}`,
      title: m.name,
      subtitle: m.stateName,
    }));
}

export function searchPages(query: string, limit = 5): SearchResult[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return SEARCHABLE_PAGES.map((p) => ({
    p,
    score: Math.max(scoreText(p.label, q), scoreText(p.keywords, q) > 0 ? 1 : 0),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => ({ group: 'pages' as const, href: p.href, title: p.label }));
}
