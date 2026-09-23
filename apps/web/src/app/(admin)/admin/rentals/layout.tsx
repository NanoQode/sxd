import type { ReactNode } from 'react';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, requireAnyStaff } from '@/lib/admin/server/context';
import { LoadError } from '@/components/admin/load-error';
import { SectionNav } from '@/components/admin/section-nav';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/admin/rentals', label: 'Leases', exact: true, alsoActive: ['/admin/rentals/leases/'] },
  { href: '/admin/rentals/work-orders', label: 'Work orders' },
  { href: '/admin/rentals/statements', label: 'Owner statements' },
  { href: '/admin/rentals/payouts', label: 'Payouts' },
  { href: '/admin/rentals/rent-run', label: 'Rent invoicing run' },
];

/**
 * Rentals and maintenance: leases, rent charges and arrears, work orders with
 * SLA flags, owner statements and two-approver payouts. Read-only staff
 * (customers.read, finance.read) can look; each action checks its own
 * permission on the server.
 */
export default async function RentalsLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/admin/rentals');
  const allowed = await attempt(async () =>
    requireAnyStaff(identity, [
      'rentals.manage',
      'maintenance.manage',
      'estates.manage',
      'customers.read',
      'finance.read',
    ]),
  );
  if (!allowed.ok)
    return (
      <LoadError code={allowed.code} message={allowed.message} what="Rentals and maintenance" />
    );
  return (
    <div className="space-y-6">
      <SectionNav items={NAV} label="Rentals sections" />
      {children}
    </div>
  );
}
