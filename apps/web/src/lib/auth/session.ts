import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, withActor, type ActorContext } from '@simplexd/db';
import {
  anonymousActor,
  assertAllowed,
  authorizeAny,
  authorizeOrg,
  authorizeStaff,
  type Actor,
  type OrgPermission,
  type OrgRole,
  type PartnerPermission,
  type ResourceRef,
  type StaffPermission,
  type StaffRole,
  type TenantPermission,
} from '@simplexd/domain/authz';
import { evaluateFeatureFlags, type FeatureFlagRow } from '../features';
import { auth, type Session } from './server';

export const ANON_COOKIE = 'sx_anon';

export interface RequestIdentity {
  session: Session | null;
  actor: Actor;
  /** Database row-level security context for this request. */
  ctx: ActorContext;
  profile: typeof schema.userProfiles.$inferSelect | null;
  featureFlags: Record<string, boolean>;
}

const loadFlagRows = cache(async (): Promise<FeatureFlagRow[]> => {
  return getDb()
    .select({
      key: schema.featureFlags.key,
      enabled: schema.featureFlags.enabled,
      rollout: schema.featureFlags.rollout,
    })
    .from(schema.featureFlags);
});

export const getSession = cache(async (): Promise<Session | null> => {
  const h = await headers();
  return auth.api.getSession({ headers: h });
});

/**
 * Resolves who is making the request: staff roles, organisation memberships,
 * partner status and MFA state. Cached per request.
 */
export const getIdentity = cache(async (): Promise<RequestIdentity> => {
  const session = await getSession();
  const cookieStore = await cookies();
  const anonymousToken = cookieStore.get(ANON_COOKIE)?.value ?? null;
  const flagRows = await loadFlagRows();
  if (!session) {
    const featureFlags = evaluateFeatureFlags(flagRows, { staff: false, organizationId: null });
    return {
      session: null,
      actor: { ...anonymousActor, flags: featureFlags },
      ctx: { userId: null, organizationId: null, staff: false, anonymousToken },
      profile: null,
      featureFlags,
    };
  }
  const db = getDb();
  const userId = session.user.id;
  const [roles, memberships, partner, profile] = await withActor(
    db,
    { userId, organizationId: null, staff: false },
    async (tx) => {
      return Promise.all([
        tx
          .select({ role: schema.staffRoles.role })
          .from(schema.staffRoles)
          .where(and(eq(schema.staffRoles.userId, userId), isNull(schema.staffRoles.revokedAt))),
        tx
          .select({ organizationId: schema.member.organizationId, role: schema.member.role })
          .from(schema.member)
          .where(eq(schema.member.userId, userId)),
        tx
          .select({ id: schema.partnerProfiles.id })
          .from(schema.partnerProfiles)
          .where(eq(schema.partnerProfiles.userId, userId)),
        tx.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)),
      ]);
    },
  );
  const staffRoles = roles.map((r) => r.role as StaffRole);
  const memberList = memberships.map((m) => ({
    organizationId: m.organizationId,
    role: normalizeOrgRole(m.role),
  }));
  const activeOrganizationId =
    (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ??
    memberList[0]?.organizationId ??
    null;
  const twoFactorEnabled = Boolean(
    (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled,
  );
  const impersonatedBy =
    (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? null;
  const featureFlags = evaluateFeatureFlags(flagRows, {
    staff: staffRoles.length > 0,
    organizationId: activeOrganizationId,
  });
  const actor: Actor = {
    userId,
    staffRoles,
    memberships: memberList,
    activeOrganizationId,
    isPartner: partner.length > 0,
    mfaVerified: twoFactorEnabled,
    impersonation: impersonatedBy
      ? { adminUserId: impersonatedBy, expiresAt: session.session.expiresAt.toISOString() }
      : null,
    flags: featureFlags,
  };
  return {
    session,
    actor,
    ctx: {
      userId,
      organizationId: activeOrganizationId,
      staff: staffRoles.length > 0,
      anonymousToken,
    },
    profile: profile[0] ?? null,
    featureFlags,
  };
});

function normalizeOrgRole(role: string): OrgRole {
  const known: OrgRole[] = ['owner', 'member', 'adviser', 'approver', 'tenant'];
  if ((known as string[]).includes(role)) return role as OrgRole;
  if (role === 'admin') return 'owner';
  return 'member';
}

/** Page helper: redirect to sign-in when anonymous. */
export async function requireSignedIn(nextPath?: string): Promise<RequestIdentity> {
  const identity = await getIdentity();
  if (!identity.session) {
    redirect(`/sign-in${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ''}`);
  }
  return identity;
}

export async function requireStaffPage(
  permission: StaffPermission,
  resource?: ResourceRef,
): Promise<RequestIdentity> {
  const identity = await requireSignedIn('/admin');
  const decision = authorizeStaff(identity.actor, permission, resource);
  if (!decision.allowed) {
    if (decision.code === 'mfa_required') redirect('/admin/security/mfa?required=1');
    redirect('/portal?denied=admin');
  }
  return identity;
}

/** API helper: throws ApiError-compatible authorization errors. */
export async function requireStaff(
  permission: StaffPermission,
  resource?: ResourceRef,
): Promise<RequestIdentity> {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeStaff(identity.actor, permission, resource));
  return identity;
}

export async function requireOrg(
  permission: OrgPermission,
  resource: ResourceRef,
): Promise<RequestIdentity> {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeOrg(identity.actor, permission, resource));
  return identity;
}

export async function requireAny(
  checks: Array<{
    staff?: StaffPermission;
    org?: OrgPermission;
    partner?: PartnerPermission;
    tenant?: TenantPermission;
  }>,
  resource: ResourceRef,
): Promise<RequestIdentity> {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeAny(identity.actor, checks, resource));
  return identity;
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}
