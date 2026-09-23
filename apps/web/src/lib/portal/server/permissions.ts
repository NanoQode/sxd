import 'server-only';
import { orgPermissions, type OrgPermission } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Customer capabilities for the active organisation, used to show a working
 * action, explain why it is unavailable, or hide it. The API re-checks every
 * permission; these flags only decide what the interface offers.
 */
export interface CustomerCapabilities {
  organizationId: string | null;
  role: string | null;
  isStaff: boolean;
  impersonated: boolean;
  can: (permission: OrgPermission) => boolean;
  acceptQuotes: boolean;
  payInvoices: boolean;
  uploadDocuments: boolean;
  viewDocuments: boolean;
  approveChangeOrders: boolean;
  acceptMilestones: boolean;
  manageProperties: boolean;
  sendMessages: boolean;
  manageAppointments: boolean;
  viewReports: boolean;
}

export function customerCapabilities(
  identity: RequestIdentity,
  organizationId: string | null = identity.ctx.organizationId,
): CustomerCapabilities {
  const perms = orgPermissions(identity.actor, organizationId);
  const membership = identity.actor.memberships.find((m) => m.organizationId === organizationId);
  const impersonated = identity.actor.impersonation !== null;
  // Financial approvals and payments are blocked while a support impersonation is active.
  const can = (p: OrgPermission) => perms.has(p);
  const guarded = (p: OrgPermission) => !impersonated && perms.has(p);
  return {
    organizationId,
    role: membership?.role ?? null,
    isStaff: identity.actor.staffRoles.length > 0,
    impersonated,
    can,
    acceptQuotes: guarded('org.quotes.accept'),
    payInvoices: guarded('org.invoices.pay'),
    uploadDocuments: can('org.documents.upload'),
    viewDocuments: can('org.documents.view'),
    approveChangeOrders: guarded('org.change_orders.approve'),
    acceptMilestones: guarded('org.milestones.accept'),
    manageProperties: can('org.properties.manage'),
    sendMessages: can('org.messages.send'),
    manageAppointments: can('org.appointments.manage'),
    viewReports: can('org.reports.view'),
  };
}

/** Explains a missing capability in the interface instead of showing a dead button. */
export function capabilityNote(capabilities: CustomerCapabilities, what: string): string {
  if (capabilities.impersonated) {
    return `${what} is blocked while support impersonation is active.`;
  }
  const role = capabilities.role ? `your ${capabilities.role} role` : 'your role';
  return `${what} needs an owner or approver of this organisation; ${role} can view but not decide.`;
}
