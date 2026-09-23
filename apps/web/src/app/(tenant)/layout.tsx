import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { TenantShell } from '@/components/tenant/tenant-shell';
import { requireSignedIn } from '@/lib/auth/session';
import { pickCurrentLease, unreadCount } from '@/lib/tenant/model';
import { loadMyLeases, loadNotices } from '@/lib/tenant/server/data';

export const metadata: Metadata = {
  title: { default: 'Tenant', template: '%s · Tenant · SimplexD' },
  robots: { index: false, follow: false, noarchive: true },
};
export const dynamic = 'force-dynamic';

/**
 * Tenant area (`/tenant/**`). Every page requires a session (the proxy
 * redirects anonymous visitors to sign-in first). The shell only needs the
 * caller's own leases and notices; pages load their own data and render
 * their own empty and error states.
 */
export default async function TenantLayout({ children }: { children: ReactNode }) {
  const path = (await headers()).get('x-pathname');
  const identity = await requireSignedIn(path?.startsWith('/tenant') ? path : '/tenant');
  const [leases, notices] = await Promise.all([loadMyLeases(identity), loadNotices(identity)]);
  const current = leases.ok ? pickCurrentLease(leases.data) : null;
  return (
    <TenantShell
      user={{ name: identity.session!.user.name, email: identity.session!.user.email }}
      currentLeaseId={current?.lease.id ?? null}
      unreadNotices={notices.ok ? unreadCount(notices.data) : 0}
      hasPortal={identity.actor.memberships.length > 0}
      impersonation={identity.actor.impersonation ?? null}
    >
      {children}
    </TenantShell>
  );
}
