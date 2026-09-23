import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { and, eq } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import { requireSignedIn, type RequestIdentity } from '@/lib/auth/session';
import { listMemberships } from '@/server/portal/organizations';
import { PortalShell } from './portal-shell';

export const metadata: Metadata = { robots: { index: false, follow: false, noarchive: true } };
export const dynamic = 'force-dynamic';

/**
 * Customer portal shell. Every page beneath requires a session; the active
 * organisation drives row-level security, so switching organisations refreshes
 * the server tree and clears client caches (see PortalShell).
 */
/** True when the user holds an active tenancy (a lease party with access). */
async function hasActiveTenancy(identity: RequestIdentity): Promise<boolean> {
  const userId = identity.session?.user.id;
  if (!userId) return false;
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ id: schema.leaseParties.id })
      .from(schema.leaseParties)
      .where(
        and(eq(schema.leaseParties.userId, userId), eq(schema.leaseParties.accessStatus, 'active')),
      )
      .limit(1),
  );
  return rows.length > 0;
}

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/portal');
  const memberships = await listMemberships(identity);
  // Sign-in lands on /portal. Accounts that are only tenants or only partners
  // (no customer organisation, no staff role) belong in their own areas.
  if (memberships.length === 0 && identity.actor.staffRoles.length === 0) {
    if (await hasActiveTenancy(identity)) redirect('/tenant');
    if (identity.actor.isPartner) redirect('/partner');
  }
  const impersonation = identity.actor.impersonation ?? null;
  return (
    <PortalShell
      user={{ name: identity.session!.user.name, email: identity.session!.user.email }}
      memberships={memberships}
      activeOrganizationId={identity.ctx.organizationId}
      isStaff={identity.actor.staffRoles.length > 0}
      impersonation={impersonation}
    >
      {children}
    </PortalShell>
  );
}
