import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requireSignedIn } from '@/lib/auth/session';
import { listMemberships } from '@/server/portal/organizations';
import { PortalShell } from './portal-shell';

export const metadata: Metadata = { robots: { index: false, follow: false, noarchive: true } };
export const dynamic = 'force-dynamic';

/**
 * Customer portal shell. Every page beneath requires a session; the active
 * organisation drives row-level security, so switching organisations refreshes
 * the server tree and clears client caches (see PortalShell).
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/portal');
  const memberships = await listMemberships(identity);
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
