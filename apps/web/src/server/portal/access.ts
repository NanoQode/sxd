import 'server-only';
import { ApiError } from '@simplexd/contracts';
import { assertAllowed, authorizeOrg, type OrgPermission } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Customer endpoints need a signed-in user with an active customer
 * organisation. Staff acting without an organisation get an explicit message
 * instead of a generic permission failure.
 */
export function requireActiveOrganization(identity: RequestIdentity): string {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const orgId = identity.ctx.organizationId;
  if (!orgId) {
    throw new ApiError('forbidden', 'create or join an organisation before using the portal', {
      details: { code: 'no_organization', next: '/onboarding' },
    });
  }
  return orgId;
}

/** Authorises an organisation permission against a specific resource's organisation. */
export function assertOrgPermission(
  identity: RequestIdentity,
  permission: OrgPermission,
  resource: { type: string; id?: string; organizationId: string | null },
): void {
  assertAllowed(authorizeOrg(identity.actor, permission, resource));
}
