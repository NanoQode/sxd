/**
 * Permission catalogue. Permissions are granular capabilities; roles are named
 * bundles. Authorisation additionally evaluates resource relationships
 * (organisation membership, assignments, explicit grants), so a permission
 * alone never grants cross-organisation access.
 */

export const STAFF_PERMISSIONS = [
  // Organisation and platform
  'platform.settings.manage',
  'platform.feature_flags.manage',
  'platform.break_glass',
  'access.staff_roles.manage',
  'access.partners.verify',
  'audit.read',
  // Integrations and secrets
  'integrations.read',
  'integrations.manage',
  'integrations.test',
  'integrations.secrets.rotate',
  'integrations.payment_credentials.manage',
  // Customers and support
  'customers.read',
  'customers.manage',
  'customers.read_sensitive',
  'support.tickets.read',
  'support.tickets.manage',
  'support.impersonate',
  // Market data
  'market_data.read_drafts',
  'market_data.edit',
  'market_data.import',
  'market_data.publish',
  'market_data.policy.manage',
  'market_data.history.read',
  // Content
  'content.edit',
  'content.publish',
  'content.media.manage',
  // Services and CRM
  'leads.read',
  'leads.manage',
  'service_requests.read_all',
  'service_requests.triage',
  'service_requests.assign',
  'service_requests.override',
  'quotes.issue',
  'pricing.manage',
  'sla.manage',
  // Projects and delivery
  'projects.read_all',
  'projects.manage',
  'site_visits.perform',
  'reports.draft',
  'reports.review',
  'reports.release',
  'change_orders.staff_approve',
  'milestones.record_progress',
  'milestones.finance_authorize',
  'evidence.approve',
  'files.read_all',
  'files.sensitive.read',
  // Finance
  'finance.read',
  'finance.invoices.manage',
  'finance.allocations.manage',
  'finance.reconcile',
  'finance.refunds.request',
  'finance.refunds.approve',
  'finance.payouts.first_approve',
  'finance.payouts.second_approve',
  'finance.export',
  'finance.tax.manage',
  // Commercial
  'tenders.manage',
  'bids.evaluate',
  'bids.open_sealed',
  'procurement.manage',
  // Rentals and maintenance
  'rentals.manage',
  'maintenance.manage',
  'estates.manage',
  // Scheduling and messaging
  'appointments.manage_all',
  'appointments.test_booking',
  'messages.read_all',
  'notifications.templates.manage',
  'notifications.test_send',
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const ORG_PERMISSIONS = [
  'org.read',
  'org.settings.manage',
  'org.members.invite',
  'org.members.manage',
  'org.properties.manage',
  'org.requests.create',
  'org.requests.cancel',
  'org.quotes.accept',
  'org.invoices.view',
  'org.invoices.pay',
  'org.documents.upload',
  'org.documents.view',
  'org.change_orders.approve',
  'org.milestones.accept',
  'org.reports.view',
  'org.messages.send',
  'org.appointments.manage',
  'org.scenarios.manage',
  'org.listings.manage',
  'org.leases.manage',
  'org.maintenance.request',
  'org.comment',
  'org.export',
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const TENANT_PERMISSIONS = [
  'tenant.lease.view',
  'tenant.balances.view',
  'tenant.receipts.view',
  'tenant.maintenance.request',
  'tenant.appointments.view',
  'tenant.notices.view',
  'tenant.messages.send',
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];

export const PARTNER_PERMISSIONS = [
  'partner.tenders.view_invited',
  'partner.bids.submit',
  'partner.assignments.view',
  'partner.reports.draft',
  'partner.evidence.upload',
  'partner.rfqs.respond',
  'partner.deliveries.view',
  'partner.invoices.submit',
  'partner.availability.manage',
] as const;

export type PartnerPermission = (typeof PARTNER_PERMISSIONS)[number];

export type Permission = StaffPermission | OrgPermission | TenantPermission | PartnerPermission;

/** Permissions that require a verified authenticator (MFA) for staff. */
export const MFA_REQUIRED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'platform.settings.manage',
  'platform.feature_flags.manage',
  'platform.break_glass',
  'access.staff_roles.manage',
  'integrations.manage',
  'integrations.secrets.rotate',
  'integrations.payment_credentials.manage',
  'market_data.publish',
  'market_data.policy.manage',
  'finance.invoices.manage',
  'finance.allocations.manage',
  'finance.reconcile',
  'finance.refunds.approve',
  'finance.payouts.first_approve',
  'finance.payouts.second_approve',
  'finance.export',
  'support.impersonate',
  'bids.open_sealed',
]);

/** Permissions that are never available while impersonating a customer. */
export const IMPERSONATION_FORBIDDEN: ReadonlySet<Permission> = new Set<Permission>([
  'integrations.manage',
  'integrations.secrets.rotate',
  'integrations.payment_credentials.manage',
  'finance.refunds.approve',
  'finance.payouts.first_approve',
  'finance.payouts.second_approve',
  'finance.allocations.manage',
  'org.invoices.pay',
  'org.quotes.accept',
  'org.change_orders.approve',
  'org.settings.manage',
  'org.members.manage',
  'platform.break_glass',
  'access.staff_roles.manage',
]);
