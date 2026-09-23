/**
 * Navigation structure for the public site. The eight core services are
 * read from the catalogue at request time; this static list is the fallback
 * when the database is unavailable so the header still renders.
 */

export interface NavServiceItem {
  slug: string;
  name: string;
  /** Short deliverable hint shown under the name in the mega-menu. */
  hint: string;
}

export interface NavLink {
  href: string;
  label: string;
}

export const CORE_SERVICE_NAV: NavServiceItem[] = [
  {
    slug: 'construction-monitoring',
    name: 'Construction monitoring',
    hint: 'Site visits, evidence and versioned progress reports',
  },
  {
    slug: 'due-diligence',
    name: 'Due diligence',
    hint: 'Title checks, site findings and a decision memorandum',
  },
  {
    slug: 'architectural-services',
    name: 'Architectural services',
    hint: 'Design options, drawings, revisions and approvals tracking',
  },
  {
    slug: 'property-management',
    name: 'Property management',
    hint: 'Leases, collections, maintenance and owner statements',
  },
  {
    slug: 'virtual-inspections',
    name: 'Virtual inspections',
    hint: 'Checklist, photos, video and a reviewed report',
  },
  {
    slug: 'purchase-support',
    name: 'Purchase representation',
    hint: 'Shortlist, offers, conditions and closing checklist',
  },
  {
    slug: 'property-search',
    name: 'Property search',
    hint: 'Requirements, shortlist comparison and viewings',
  },
  {
    slug: 'land-sales-leasing',
    name: 'Land sales and leasing',
    hint: 'Authorised listings, disclosures and lease milestones',
  },
];

export const PRIMARY_LINKS: NavLink[] = [
  { href: '/explore', label: 'Explore Locations' },
  { href: '/properties', label: 'Properties' },
  { href: '/how-it-works', label: 'How It Works' },
  { href: '/resources', label: 'Resources' },
];

export const SECONDARY_LINKS: NavLink[] = [
  { href: '/locations', label: 'All locations' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/projects', label: 'Projects' },
  { href: '/diaspora', label: 'For the diaspora' },
  { href: '/local-nigeria', label: 'For local owners' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

/** Static pages the search dialog can find without a network request. */
export const SEARCHABLE_PAGES: Array<NavLink & { keywords: string }> = [
  { href: '/services', label: 'All services', keywords: 'services catalogue deliverables' },
  { href: '/pricing', label: 'Pricing', keywords: 'price anchors quotation fees cost' },
  { href: '/explore', label: 'Explore locations map', keywords: 'map explorer compare markets' },
  { href: '/locations', label: 'Locations', keywords: 'cities states zones coverage' },
  { href: '/properties', label: 'Properties', keywords: 'listings land sale lease verification' },
  { href: '/projects', label: 'Projects', keywords: 'case studies approved projects' },
  { href: '/how-it-works', label: 'How it works', keywords: 'process quotation evidence delivery' },
  { href: '/resources', label: 'Resources', keywords: 'guides articles reading' },
  { href: '/diaspora', label: 'For the diaspora', keywords: 'abroad time zone remote owner' },
  { href: '/local-nigeria', label: 'For local owners', keywords: 'nigeria local professionals' },
  { href: '/about', label: 'About SimplexD', keywords: 'company evidence standards' },
  { href: '/contact', label: 'Contact', keywords: 'email phone reach us' },
  {
    href: '/book',
    label: 'Book a consultation',
    keywords: 'consultation appointment call meeting',
  },
  { href: '/policies/privacy', label: 'Privacy notice', keywords: 'privacy data protection ndpa' },
  { href: '/policies/terms', label: 'Terms of service', keywords: 'terms conditions agreement' },
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
