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
  { key: 'leads', label: 'CRM / Leads', href: '/admin/leads', icon: 'leads', permissions: ['leads.read'] },
  { key: 'customers', label: 'Customers', href: '/admin/customers', icon: 'customers', permissions: ['customers.read'], plannedWave: 2 },
  { key: 'properties', label: 'Properties', href: '/admin/properties', icon: 'properties', permissions: ['customers.read', 'projects.read_all'], plannedWave: 2 },
  { key: 'projects', label: 'Projects', href: '/admin/projects', icon: 'projects', permissions: ['projects.read_all'], plannedWave: 2 },
  { key: 'service-requests', label: 'Service Requests', href: '/admin/service-requests', icon: 'requests', permissions: ['service_requests.read_all'], plannedWave: 2 },
  { key: 'assignments', label: 'Assignments', href: '/admin/assignments', icon: 'assignments', permissions: ['service_requests.assign'], plannedWave: 2 },
  { key: 'reports', label: 'Reports', href: '/admin/reports', icon: 'reports', permissions: ['reports.review', 'reports.draft', 'reports.release'], plannedWave: 2 },
  { key: 'tenders', label: 'Tenders', href: '/admin/tenders', icon: 'tenders', permissions: ['tenders.manage', 'bids.evaluate'], plannedWave: 4 },
  { key: 'procurement', label: 'Procurement', href: '/admin/procurement', icon: 'procurement', permissions: ['procurement.manage'], plannedWave: 4 },
  { key: 'rentals', label: 'Rentals / Maintenance', href: '/admin/rentals', icon: 'rentals', permissions: ['rentals.manage', 'maintenance.manage', 'estates.manage'], plannedWave: 4 },
  { key: 'finance', label: 'Finance', href: '/admin/finance', icon: 'finance', permissions: ['finance.read'], plannedWave: 3 },
  { key: 'appointments', label: 'Appointments', href: '/admin/appointments', icon: 'appointments', permissions: ['appointments.manage_all'], plannedWave: 3 },
  { key: 'messages', label: 'Messages', href: '/admin/messages', icon: 'messages', permissions: ['messages.read_all', 'support.tickets.read'], plannedWave: 2 },
  { key: 'market-data', label: 'Market Data', href: '/admin/market-data', icon: 'market-data', permissions: ['market_data.read_drafts'] },
  { key: 'content', label: 'Content', href: '/admin/content', icon: 'content', permissions: ['content.edit'] },
  { key: 'partners', label: 'Partners', href: '/admin/partners', icon: 'partners', permissions: ['access.partners.verify'], plannedWave: 4 },
  { key: 'integrations', label: 'Integrations', href: '/admin/integrations', icon: 'integrations', permissions: ['integrations.read'], plannedWave: 3 },
  { key: 'settings', label: 'Settings', href: '/admin/settings', icon: 'settings', permissions: ['platform.settings.manage', 'platform.feature_flags.manage', 'access.staff_roles.manage'] },
  { key: 'audit', label: 'Audit', href: '/admin/audit', icon: 'audit', permissions: ['audit.read'] },
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
  { label: 'Markets', href: '/admin/market-data', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'New market', href: '/admin/market-data/markets/new', parent: 'market-data', permissions: ['market_data.edit'] },
  { label: 'Observation queue', href: '/admin/market-data/observations', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'Record observation', href: '/admin/market-data/observations/new', parent: 'market-data', permissions: ['market_data.edit'] },
  { label: 'Sources', href: '/admin/market-data/sources', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'Imports', href: '/admin/market-data/imports', parent: 'market-data', permissions: ['market_data.import'] },
  { label: 'Exports', href: '/admin/market-data/exports', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'Ranking policies', href: '/admin/market-data/ranking-policies', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'Freshness policies', href: '/admin/market-data/freshness', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'Data policy settings', href: '/admin/market-data/data-policies', parent: 'market-data', permissions: ['market_data.read_drafts'] },
  { label: 'Feature flags', href: '/admin/settings/feature-flags', parent: 'settings', permissions: ['platform.feature_flags.manage'] },
  { label: 'Platform settings', href: '/admin/settings', parent: 'settings', permissions: ['platform.settings.manage'] },
  { label: 'Access: staff roles', href: '/admin/access', parent: 'settings', permissions: ['access.staff_roles.manage'] },
  { label: 'Access: partner verification', href: '/admin/access/partners', parent: 'settings', permissions: ['access.partners.verify'] },
  { label: 'Security: authenticator (MFA)', href: '/admin/security/mfa', parent: 'settings', permissions: [] },
  { label: 'Implementation status', href: '/admin/implementation-status', parent: 'overview', permissions: [] },
];

export function visibleSubNav(permissions: ReadonlySet<StaffPermission>): SubNavItem[] {
  return ADMIN_SUBNAV.filter(
    (item) => item.permissions.length === 0 || item.permissions.some((p) => permissions.has(p)),
  );
}

export interface PlannedSection {
  key: string;
  title: string;
  wave: number;
  summary: string;
  related?: Array<{ label: string; href: string }>;
}

export const PLANNED_SECTIONS: Record<string, PlannedSection> = {
  customers: { key: 'customers', title: 'Customers', wave: 2, summary: 'Customer organisations, members, granted access, masked sensitive fields and support escalation arrive with the service-delivery portals.' },
  properties: { key: 'properties', title: 'Properties', wave: 2, summary: 'Private property assets, parcels, units, owner authority and listing moderation are part of the service workflows.' },
  projects: { key: 'projects', title: 'Projects', wave: 2, summary: 'Baselines, budgets, schedules, site visits, evidence, defects and change orders ship with the eight core service modules.' },
  'service-requests': { key: 'service-requests', title: 'Service Requests', wave: 2, summary: 'Triage, SLA queues, quotations and the engagement state machine are wired to the portals in the service-delivery wave.' },
  assignments: { key: 'assignments', title: 'Assignments', wave: 2, summary: 'Staff and partner assignments, workload and calendar views are delivered with service requests and projects.' },
  reports: { key: 'reports', title: 'Reports', wave: 2, summary: 'Report templates, named reviewers and versioned releases belong to the service workflows.' },
  tenders: { key: 'tenders', title: 'Tenders', wave: 4, summary: 'Sealed submissions, clarifications, weighted evaluation and published awards are an expansion workflow.' },
  procurement: { key: 'procurement', title: 'Procurement', wave: 4, summary: 'Supplier directory, RFQs, normalised delivered-cost comparisons, purchase orders and delivery discrepancies are an expansion workflow.' },
  rentals: { key: 'rentals', title: 'Rentals / Maintenance', wave: 4, summary: 'Leases, rent schedules, work orders, assets and owner statements arrive with the rental and maintenance modules.' },
  finance: { key: 'finance', title: 'Finance', wave: 3, summary: 'Invoices, payment reconciliation, refunds, payouts and ledger exports are delivered with the payment gateway integration.' },
  appointments: { key: 'appointments', title: 'Appointments', wave: 3, summary: 'Availability, holds, Google Calendar and Meet synchronisation and reminders ship with the scheduling integration.' },
  messages: { key: 'messages', title: 'Messages', wave: 2, summary: 'Conversations, internal notes and notification templates are part of the portal wave.' },
  partners: {
    key: 'partners',
    title: 'Partners',
    wave: 4,
    summary: 'Partner credentials, coverage, availability, conflict disclosures and reviews arrive with the professional partner network. Verification of partner profiles is already available under Access.',
    related: [{ label: 'Partner verification queue', href: '/admin/access/partners' }],
  },
  integrations: { key: 'integrations', title: 'Integrations', wave: 3, summary: 'Payment, SMS, SMTP, Google, storage and map providers with save/test/activate states, sanitized logs and secret rotation are delivered in the integrations wave.' },
};
