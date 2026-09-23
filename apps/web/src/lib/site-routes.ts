/**
 * What the app itself serves, as far as redirects and the migration
 * reconciliation need to know. No database access: the dynamic segments are
 * resolved by the caller (see server/content/site-routes.ts and
 * scripts/reconcile-inventory.ts).
 */

/** Prefixes that may never be the source of a redirect: private, internal or API surfaces. */
export const RESERVED_PATH_PREFIXES = [
  '/api',
  '/_next',
  '/admin',
  '/portal',
  '/partner',
  '/tenant',
  '/preview',
  '/setup',
  '/onboarding',
  '/invitations',
  '/dev',
  '/media',
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/two-factor',
] as const;

/** Public pages that exist as files in the app router (exact paths). */
export const PUBLIC_STATIC_ROUTES = [
  '/',
  '/about',
  '/book',
  '/contact',
  '/diaspora',
  '/explore',
  '/how-it-works',
  '/local-nigeria',
  '/locations',
  '/pricing',
  '/projects',
  '/properties',
  '/resources',
  '/services',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
] as const;

export type DynamicRouteKind = 'market' | 'service' | 'resource' | 'policy' | 'listing';

/** Dynamic public segments and the entity that must exist for the path to resolve. */
export const PUBLIC_DYNAMIC_ROUTES: ReadonlyArray<{ prefix: string; kind: DynamicRouteKind }> = [
  { prefix: '/locations/', kind: 'market' },
  { prefix: '/services/', kind: 'service' },
  { prefix: '/resources/', kind: 'resource' },
  { prefix: '/policies/', kind: 'policy' },
  { prefix: '/properties/', kind: 'listing' },
];

/** Strips a trailing slash (except for the root) and the query/hash. */
export function normalizeSitePath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? path;
  const trimmed = bare.trim();
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1);
  return trimmed;
}

/** Accepts `/path` or an absolute http(s) URL and returns the app path, or null. */
export function toSitePath(value: string): string | null {
  const v = value.trim();
  if (v.startsWith('/')) return v.startsWith('//') ? null : normalizeSitePath(v);
  if (/^https?:\/\//i.test(v)) {
    try {
      const url = new URL(v);
      return normalizeSitePath(url.pathname);
    } catch {
      return null;
    }
  }
  return null;
}

export function isReservedPath(path: string): boolean {
  const p = normalizeSitePath(path);
  return RESERVED_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

export function isStaticPublicRoute(path: string): boolean {
  return (PUBLIC_STATIC_ROUTES as readonly string[]).includes(normalizeSitePath(path));
}

/** Splits a dynamic public path into its entity kind and slug, if it matches one. */
export function dynamicRouteOf(path: string): { kind: DynamicRouteKind; slug: string } | null {
  const p = normalizeSitePath(path);
  for (const route of PUBLIC_DYNAMIC_ROUTES) {
    if (p.startsWith(route.prefix)) {
      const rest = p.slice(route.prefix.length);
      if (rest && !rest.includes('/')) return { kind: route.kind, slug: rest };
    }
  }
  return null;
}
