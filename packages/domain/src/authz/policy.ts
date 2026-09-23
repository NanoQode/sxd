import {
  IMPERSONATION_FORBIDDEN,
  MFA_REQUIRED_PERMISSIONS,
  type OrgPermission,
  type PartnerPermission,
  type Permission,
  type StaffPermission,
  type TenantPermission,
} from './permissions';
import {
  ORG_ROLE_PERMISSIONS,
  PARTNER_ROLE_PERMISSIONS,
  STAFF_ROLE_PERMISSIONS,
  TENANT_ROLE_PERMISSIONS,
  type OrgRole,
  type StaffRole,
} from './roles';

export interface Membership {
  organizationId: string;
  role: OrgRole;
}

export interface ResourceGrant {
  userId: string;
  level: 'view' | 'comment' | 'edit' | 'approve';
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface Actor {
  userId: string | null;
  staffRoles: StaffRole[];
  memberships: Membership[];
  activeOrganizationId: string | null;
  isPartner: boolean;
  mfaVerified: boolean;
  impersonation?: { adminUserId: string; expiresAt: string } | null;
  /** Feature flags relevant to authorisation (e.g. core.impersonation). */
  flags?: Record<string, boolean>;
}

export interface ResourceRef {
  type: string;
  id?: string;
  organizationId?: string | null;
  /** Creator/author for "not own work" rules. */
  createdBy?: string | null;
  /** Users assigned to the resource (partners, staff). */
  assigneeUserIds?: string[];
  /** Explicit grants on this resource. */
  grants?: ResourceGrant[];
  /** Project/service-request ids a project manager is assigned to. */
  assignedProjectIds?: string[];
  /** Is the resource public (published listing/page)? */
  isPublic?: boolean;
  /** Arbitrary attributes for specific rules. */
  attributes?: Record<string, unknown>;
}

export type Decision =
  { allowed: true; via: string } | { allowed: false; reason: string; code: DenyCode };

export type DenyCode =
  | 'unauthenticated'
  | 'no_permission'
  | 'wrong_organization'
  | 'mfa_required'
  | 'impersonation_forbidden'
  | 'own_work'
  | 'separation_of_duties'
  | 'not_assigned'
  | 'grant_expired'
  | 'feature_disabled'
  | 'partner_not_invited';

export const anonymousActor: Actor = {
  userId: null,
  staffRoles: [],
  memberships: [],
  activeOrganizationId: null,
  isPartner: false,
  mfaVerified: false,
};

function deny(code: DenyCode, reason: string): Decision {
  return { allowed: false, code, reason };
}

export function staffPermissions(actor: Actor): Set<StaffPermission> {
  const set = new Set<StaffPermission>();
  for (const role of actor.staffRoles) {
    for (const p of STAFF_ROLE_PERMISSIONS[role]) set.add(p);
  }
  return set;
}

export function isStaff(actor: Actor): boolean {
  return actor.staffRoles.length > 0;
}

export function hasStaffPermission(actor: Actor, permission: StaffPermission): boolean {
  return staffPermissions(actor).has(permission);
}

export function membershipFor(
  actor: Actor,
  organizationId: string | null | undefined,
): Membership | undefined {
  if (!organizationId) return undefined;
  return actor.memberships.find((m) => m.organizationId === organizationId);
}

export function orgPermissions(
  actor: Actor,
  organizationId: string | null | undefined,
): Set<OrgPermission> {
  const m = membershipFor(actor, organizationId);
  if (!m) return new Set();
  return new Set(ORG_ROLE_PERMISSIONS[m.role]);
}

function activeGrant(resource: ResourceRef, userId: string, now: Date): ResourceGrant | undefined {
  return resource.grants?.find(
    (g) => g.userId === userId && !g.revokedAt && (!g.expiresAt || new Date(g.expiresAt) > now),
  );
}

const GRANT_LEVEL_RANK = { view: 1, comment: 2, edit: 3, approve: 4 } as const;

export interface AuthorizeOptions {
  now?: Date;
}

function gateSensitive(actor: Actor, permission: Permission): Decision | null {
  if (actor.impersonation && IMPERSONATION_FORBIDDEN.has(permission)) {
    return deny('impersonation_forbidden', `${permission} is not available while impersonating`);
  }
  if (isStaff(actor) && MFA_REQUIRED_PERMISSIONS.has(permission) && !actor.mfaVerified) {
    return deny('mfa_required', `${permission} requires a verified authenticator`);
  }
  return null;
}

/**
 * Checks a staff permission, then the resource relationship rules that the
 * brief attaches to specific roles. Default deny.
 */
export function authorizeStaff(
  actor: Actor,
  permission: StaffPermission,
  resource?: ResourceRef,
  _options: AuthorizeOptions = {},
): Decision {
  if (!actor.userId) return deny('unauthenticated', 'sign in required');
  const gate = gateSensitive(actor, permission);
  if (gate) return gate;
  const perms = staffPermissions(actor);
  if (!perms.has(permission)) return deny('no_permission', `missing ${permission}`);
  if (permission === 'support.impersonate' && !actor.flags?.['core.impersonation']) {
    return deny('feature_disabled', 'impersonation is disabled by feature flag');
  }
  if (resource) {
    // Project managers only reach assigned projects and requests unless they hold a broader role.
    const broad = actor.staffRoles.some((r) => r === 'super_admin' || r === 'operations_manager');
    if (
      !broad &&
      actor.staffRoles.includes('project_manager') &&
      ['project', 'service_request'].includes(resource.type)
    ) {
      const assigned =
        resource.assigneeUserIds?.includes(actor.userId) ||
        (resource.id ? resource.assignedProjectIds?.includes(resource.id) : false);
      if (!assigned)
        return deny('not_assigned', 'project manager is not assigned to this resource');
    }
    if (
      !broad &&
      actor.staffRoles.includes('inspector') &&
      ['site_visit', 'report', 'project'].includes(resource.type)
    ) {
      const assigned =
        resource.assigneeUserIds?.includes(actor.userId) || resource.createdBy === actor.userId;
      if (!assigned) return deny('not_assigned', 'inspector is not assigned to this resource');
    }
    // Separation of duties: nobody approves or releases their own work.
    if (
      [
        'reports.release',
        'reports.review',
        'market_data.publish',
        'evidence.approve',
        'finance.refunds.approve',
      ].includes(permission)
    ) {
      if (resource.createdBy && resource.createdBy === actor.userId) {
        return deny('own_work', `${permission} cannot be applied to your own submission`);
      }
    }
    if (
      permission === 'finance.payouts.second_approve' &&
      resource.attributes?.['firstApproverId'] === actor.userId
    ) {
      return deny('separation_of_duties', 'second approval must come from a different approver');
    }
    if (
      permission === 'files.read_all' &&
      resource.attributes?.['sensitive'] === true &&
      !perms.has('files.sensitive.read')
    ) {
      return deny('no_permission', 'sensitive documents require files.sensitive.read');
    }
  }
  return { allowed: true, via: `staff:${permission}` };
}

/** Customer organisation permission: membership in the resource's organisation plus role capability, or an explicit grant. */
export function authorizeOrg(
  actor: Actor,
  permission: OrgPermission,
  resource: ResourceRef,
  options: AuthorizeOptions = {},
): Decision {
  if (!actor.userId) return deny('unauthenticated', 'sign in required');
  const gate = gateSensitive(actor, permission);
  if (gate) return gate;
  const now = options.now ?? new Date();
  const orgId = resource.organizationId ?? actor.activeOrganizationId;
  if (orgId && actor.activeOrganizationId && orgId !== actor.activeOrganizationId) {
    // The active organisation must match: switching organisations resets private context.
    return deny(
      'wrong_organization',
      'resource belongs to a different organisation than the active one',
    );
  }
  const perms = orgPermissions(actor, orgId);
  if (perms.has(permission)) return { allowed: true, via: `org:${permission}` };
  const grant = activeGrant(resource, actor.userId, now);
  if (grant) {
    const needed = grantLevelFor(permission);
    if (needed && GRANT_LEVEL_RANK[grant.level] >= GRANT_LEVEL_RANK[needed]) {
      return { allowed: true, via: `grant:${grant.level}` };
    }
  }
  if (resource.grants?.some((g) => g.userId === actor.userId))
    return deny('grant_expired', 'the access grant has expired or was revoked');
  return deny(
    'no_permission',
    membershipFor(actor, orgId) ? `role lacks ${permission}` : 'not a member of this organisation',
  );
}

function grantLevelFor(permission: OrgPermission): ResourceGrant['level'] | null {
  if (permission.endsWith('.view') || permission === 'org.read') return 'view';
  if (permission === 'org.comment' || permission === 'org.messages.send') return 'comment';
  if (permission.endsWith('.approve') || permission.endsWith('.accept')) return 'approve';
  if (
    permission === 'org.documents.upload' ||
    permission.endsWith('.manage') ||
    permission.endsWith('.create')
  )
    return 'edit';
  return null;
}

export function authorizeTenant(
  actor: Actor,
  permission: TenantPermission,
  resource: ResourceRef,
): Decision {
  if (!actor.userId) return deny('unauthenticated', 'sign in required');
  if (!TENANT_ROLE_PERMISSIONS.has(permission))
    return deny('no_permission', `unknown tenant permission ${permission}`);
  const party = resource.assigneeUserIds?.includes(actor.userId);
  if (!party) return deny('not_assigned', 'tenant is not a party to this lease');
  return { allowed: true, via: `tenant:${permission}` };
}

export function authorizePartner(
  actor: Actor,
  permission: PartnerPermission,
  resource: ResourceRef,
): Decision {
  if (!actor.userId) return deny('unauthenticated', 'sign in required');
  if (!actor.isPartner) return deny('no_permission', 'not a partner account');
  if (!PARTNER_ROLE_PERMISSIONS.has(permission))
    return deny('no_permission', `unknown partner permission ${permission}`);
  if (resource.type === 'tender' || resource.type === 'bid') {
    const invited = resource.assigneeUserIds?.includes(actor.userId);
    if (!invited) return deny('partner_not_invited', 'partner was not invited to this tender');
  } else if (
    !resource.assigneeUserIds?.includes(actor.userId) &&
    resource.createdBy !== actor.userId
  ) {
    return deny('not_assigned', 'partner is not assigned to this resource');
  }
  return { allowed: true, via: `partner:${permission}` };
}

/**
 * Convenience: allow when either a staff permission or an organisation
 * permission applies. Used by endpoints shared between staff and customers.
 */
export function authorizeAny(
  actor: Actor,
  checks: Array<{
    staff?: StaffPermission;
    org?: OrgPermission;
    partner?: PartnerPermission;
    tenant?: TenantPermission;
  }>,
  resource: ResourceRef,
  options: AuthorizeOptions = {},
): Decision {
  let last: Decision = deny('no_permission', 'no applicable permission');
  for (const c of checks) {
    if (c.staff) {
      const d = authorizeStaff(actor, c.staff, resource, options);
      if (d.allowed) return d;
      last = d;
    }
    if (c.org) {
      const d = authorizeOrg(actor, c.org, resource, options);
      if (d.allowed) return d;
      last = d;
    }
    if (c.partner) {
      const d = authorizePartner(actor, c.partner, resource);
      if (d.allowed) return d;
      last = d;
    }
    if (c.tenant) {
      const d = authorizeTenant(actor, c.tenant, resource);
      if (d.allowed) return d;
      last = d;
    }
  }
  return last;
}

export class AuthorizationError extends Error {
  constructor(public readonly decision: Exclude<Decision, { allowed: true }>) {
    super(decision.reason);
    this.name = 'AuthorizationError';
  }
}

export function assertAllowed(
  decision: Decision,
): asserts decision is { allowed: true; via: string } {
  if (!decision.allowed) throw new AuthorizationError(decision);
}
