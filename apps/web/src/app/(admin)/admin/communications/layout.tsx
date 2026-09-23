import type { ReactNode } from 'react';
import { requireSignedIn, requireStaffPage } from '@/lib/auth/session';
import { SectionNav, type SectionNavItem } from '@/components/admin/section-nav';
import { adminContext } from '@/server/admin/context';
import { communicationsAccess } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * Admin → Communications: notification templates, explicit test sends, the
 * delivery log and the suppression list. Reachable with
 * notifications.templates.manage or notifications.test_send (neither is
 * MFA-gated); every page and endpoint re-checks its own permission.
 */
export default async function CommunicationsLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/admin/communications');
  const access = communicationsAccess(adminContext(identity));
  // Redirects staff without either permission the same way other admin sections do.
  if (!access.any) await requireStaffPage('notifications.test_send');
  const nav: SectionNavItem[] = [
    { href: '/admin/communications', label: 'Overview', exact: true },
    ...(access.templates ? [{ href: '/admin/communications/templates', label: 'Templates' }] : []),
    ...(access.testSend ? [{ href: '/admin/communications/test-send', label: 'Test send' }] : []),
    ...(access.templates
      ? [
          { href: '/admin/communications/deliveries', label: 'Delivery log' },
          { href: '/admin/communications/suppressions', label: 'Suppressions' },
        ]
      : []),
  ];
  return (
    <div className="space-y-6">
      <SectionNav items={nav} label="Communications sections" />
      {children}
    </div>
  );
}
