import type { StaffPermission } from '@simplexd/domain/authz';

/**
 * Admin navigation in the order fixed by the brief (§11). Items are shown only
 * when the actor holds at least one of the listed permissions; an empty list
 * means any active staff role. Visibility is never authorization: every page
 * and endpoint checks its own permission on the server.
 */

export type NavIcon =
  | 'overview'
  | 'leads'
  | 'customers'
  | 'properties'
  | 'projects'
  | 'requests'
  | 'assignments'
  | 'reports'
  | 'tenders'
  | 'procurement'
  | 'rentals'
  | 'finance'
  | 'appointments'
  | 'messages'
  | 'market-data'
  | 'content'
  | 'partners'
  | 'integrations'
  | 'settings'
  | 'operations'
  | 'services'
  | 'analytics'
  | 'audit';

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: NavIcon;
  permissions: StaffPermission[];
  /** Release wave that delivers the section when it is not built yet. */
  plannedWave?: number;
}

export const ADMIN_NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', href: '/admin', icon: 'overview', permissions: [] },
  {
    key: 'leads',
    label: 'CRM / Leads',
    href: '/admin/leads',
    icon: 'leads',
    permissions: ['leads.read'],
  },
  {
    key: 'customers',
    label: 'Customers',
    href: '/admin/customers',
    icon: 'customers',
    permissions: ['customers.read'],
  },
  {
    key: 'properties',
    label: 'Properties',
    href: '/admin/properties',
    icon: 'properties',
    permissions: ['customers.read', 'projects.read_all'],
  },
  {
    // Listing moderation queue (brief §8 land sales/leasing, §20): decisions
    // need content.publish, verification checks rentals.manage.
    key: 'listings',
    label: 'Listings',
    href: '/admin/listings',
    icon: 'properties',
    permissions: ['content.publish', 'rentals.manage'],
  },
  {
    key: 'projects',
    label: 'Projects',
    href: '/admin/projects',
    icon: 'projects',
    permissions: ['projects.read_all'],
  },
  {
    key: 'service-requests',
    label: 'Service Requests',
    href: '/admin/service-requests',
    icon: 'requests',
    permissions: ['service_requests.read_all'],
  },
  {
    // Service configuration: price anchors, quote/report templates, document requirements, SLA.
    key: 'services',
    label: 'Service Setup',
    href: '/admin/services',
    icon: 'services',
    permissions: ['pricing.manage', 'sla.manage', 'reports.review', 'quotes.issue'],
  },
  {
    key: 'assignments',
    label: 'Assignments',
    href: '/admin/assignments',
    icon: 'assignments',
    permissions: ['service_requests.assign'],
  },
  {
    key: 'reports',
    label: 'Reports',
    href: '/admin/reports',
    icon: 'reports',
    permissions: ['reports.review', 'reports.draft', 'reports.release'],
  },
  {
    key: 'tenders',
    label: 'Tenders',
    href: '/admin/tenders',
    icon: 'tenders',
    permissions: ['tenders.manage', 'bids.evaluate'],
  },
  {
    key: 'procurement',
    label: 'Procurement',
    href: '/admin/procurement',
    icon: 'procurement',
    permissions: ['procurement.manage'],
  },
  {
    key: 'rentals',
    label: 'Rentals / Maintenance',
    href: '/admin/rentals',
    icon: 'rentals',
    permissions: ['rentals.manage', 'maintenance.manage', 'estates.manage'],
  },
  {
    key: 'finance',
    label: 'Finance',
    href: '/admin/finance',
    icon: 'finance',
    permissions: ['finance.read'],
  },
  {
    // Portfolio analytics: counts and sums derived from records (brief §11, §19).
    key: 'analytics',
    label: 'Portfolio Analytics',
    href: '/admin/analytics',
    icon: 'analytics',
    permissions: ['finance.read', 'rentals.manage', 'projects.read_all', 'service_requests.read_all'],
  },
  {
    key: 'appointments',
    label: 'Appointments',
    href: '/admin/appointments',
    icon: 'appointments',
    permissions: ['appointments.manage_all'],
  },
  {
    key: 'messages',
    label: 'Messages',
    href: '/admin/messages',
    icon: 'messages',
    permissions: ['messages.read_all', 'support.tickets.read'],
  },
  {
    key: 'market-data',
    label: 'Market Data',
    href: '/admin/market-data',
    icon: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    key: 'content',
    label: 'Content',
    href: '/admin/content',
    icon: 'content',
    permissions: ['content.edit'],
  },
  {
    key: 'partners',
    label: 'Partners',
    href: '/admin/partners',
    icon: 'partners',
    permissions: ['access.partners.verify'],
  },
  {
    key: 'integrations',
    label: 'Integrations',
    href: '/admin/integrations',
    icon: 'integrations',
    permissions: ['integrations.read'],
  },
  {
    // Notification templates, test sends, delivery log and suppressions (brief §13/§14).
    key: 'communications',
    label: 'Communications',
    href: '/admin/communications',
    icon: 'messages',
    permissions: ['notifications.templates.manage', 'notifications.test_send'],
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/admin/settings',
    icon: 'settings',
    permissions: [
      'platform.settings.manage',
      'platform.feature_flags.manage',
      'access.staff_roles.manage',
    ],
  },
  {
    // Platform operations (not in the brief's list; placed with Settings/Audit).
    key: 'operations',
    label: 'Jobs & Outbox',
    href: '/admin/operations',
    icon: 'operations',
    permissions: ['audit.read', 'platform.settings.manage'],
  },
  {
    key: 'audit',
    label: 'Audit',
    href: '/admin/audit',
    icon: 'audit',
    permissions: ['audit.read'],
  },
];

export function visibleNav(permissions: ReadonlySet<StaffPermission>): NavItem[] {
  return ADMIN_NAV.filter(
    (item) => item.permissions.length === 0 || item.permissions.some((p) => permissions.has(p)),
  );
}

/** Secondary destinations inside built sections, searchable from the command palette. */
export interface SubNavItem {
  label: string;
  href: string;
  parent: string;
  permissions: StaffPermission[];
}

export const ADMIN_SUBNAV: SubNavItem[] = [
  {
    label: 'Markets',
    href: '/admin/market-data',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'New market',
    href: '/admin/market-data/markets/new',
    parent: 'market-data',
    permissions: ['market_data.edit'],
  },
  {
    label: 'Observation queue',
    href: '/admin/market-data/observations',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'Record observation',
    href: '/admin/market-data/observations/new',
    parent: 'market-data',
    permissions: ['market_data.edit'],
  },
  {
    label: 'Sources',
    href: '/admin/market-data/sources',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'Imports',
    href: '/admin/market-data/imports',
    parent: 'market-data',
    permissions: ['market_data.import'],
  },
  {
    label: 'Exports',
    href: '/admin/market-data/exports',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'Ranking policies',
    href: '/admin/market-data/ranking-policies',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'Freshness policies',
    href: '/admin/market-data/freshness',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'Data policy settings',
    href: '/admin/market-data/data-policies',
    parent: 'market-data',
    permissions: ['market_data.read_drafts'],
  },
  {
    label: 'Feature flags',
    href: '/admin/settings/feature-flags',
    parent: 'settings',
    permissions: ['platform.feature_flags.manage'],
  },
  {
    label: 'Platform settings',
    href: '/admin/settings',
    parent: 'settings',
    permissions: ['platform.settings.manage'],
  },
  {
    label: 'Access: staff roles',
    href: '/admin/access',
    parent: 'settings',
    permissions: ['access.staff_roles.manage'],
  },
  {
    label: 'Access: partner verification',
    href: '/admin/access/partners',
    parent: 'settings',
    permissions: ['access.partners.verify'],
  },
  {
    label: 'Security: authenticator (MFA)',
    href: '/admin/security/mfa',
    parent: 'settings',
    permissions: [],
  },
  {
    label: 'Operations: dead jobs',
    href: '/admin/operations?status=dead',
    parent: 'operations',
    permissions: ['audit.read', 'platform.settings.manage'],
  },
  {
    label: 'Operations: stuck outbox events',
    href: '/admin/operations#stuck-outbox',
    parent: 'operations',
    permissions: ['audit.read', 'platform.settings.manage'],
  },
  {
    label: 'Implementation status',
    href: '/admin/implementation-status',
    parent: 'overview',
    permissions: [],
  },
  {
    label: 'Communications: templates',
    href: '/admin/communications/templates',
    parent: 'communications',
    permissions: ['notifications.templates.manage'],
  },
  {
    label: 'Communications: test send',
    href: '/admin/communications/test-send',
    parent: 'communications',
    permissions: ['notifications.test_send'],
  },
  {
    label: 'Communications: delivery log',
    href: '/admin/communications/deliveries',
    parent: 'communications',
    permissions: ['notifications.templates.manage'],
  },
  {
    label: 'Communications: suppressions',
    href: '/admin/communications/suppressions',
    parent: 'communications',
    permissions: ['notifications.templates.manage'],
  },
  {
    label: 'Service setup: price anchors',
    href: '/admin/services',
    parent: 'services',
    permissions: ['pricing.manage'],
  },
  {
    label: 'Service setup: quote templates',
    href: '/admin/services/quote-templates',
    parent: 'services',
    permissions: ['pricing.manage', 'quotes.issue'],
  },
  {
    label: 'Service setup: report templates',
    href: '/admin/services/report-templates',
    parent: 'services',
    permissions: ['reports.review', 'reports.draft', 'reports.release'],
  },
  {
    label: 'Service setup: document requirements',
    href: '/admin/services/document-requirements',
    parent: 'services',
    permissions: ['pricing.manage', 'service_requests.read_all'],
  },
  {
    label: 'Service setup: SLA policies',
    href: '/admin/services/sla-policies',
    parent: 'services',
    permissions: ['sla.manage', 'service_requests.read_all'],
  },
  {
    label: 'Portfolio analytics',
    href: '/admin/analytics',
    parent: 'analytics',
    permissions: ['finance.read', 'rentals.manage', 'projects.read_all', 'service_requests.read_all'],
  },
];

export function visibleSubNav(permissions: ReadonlySet<StaffPermission>): SubNavItem[] {
  return ADMIN_SUBNAV.filter(
    (item) => item.permissions.length === 0 || item.permissions.some((p) => permissions.has(p)),
  );
}
