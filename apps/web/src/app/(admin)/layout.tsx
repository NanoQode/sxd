import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { staffPermissions } from '@simplexd/domain/authz';
import { isStaffIdentity, requireSignedIn } from '@/lib/auth/session';
import { AdminShell } from './admin/_components/shell';
import { visibleNav, visibleSubNav } from './admin/_lib/navigation';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin · SimplexD' },
  robots: { index: false, follow: false, noarchive: true },
};

export const dynamic = 'force-dynamic';

/**
 * Admin console shell. Any active staff role may enter; each section and
 * endpoint checks its own permission. Navigation is filtered by permission
 * for clarity only (UI visibility is never authorization).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/admin');
  if (!isStaffIdentity(identity)) redirect('/portal?denied=admin');
  const permissions = staffPermissions(identity.actor);
  return (
    <AdminShell
      nav={visibleNav(permissions)}
      subNav={visibleSubNav(permissions)}
      user={{ name: identity.session!.user.name, email: identity.session!.user.email }}
      roles={identity.actor.staffRoles}
      mfaVerified={identity.actor.mfaVerified}
      canSearchMarkets={permissions.has('market_data.read_drafts')}
    >
      {children}
    </AdminShell>
  );
}
