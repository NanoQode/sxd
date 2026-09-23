import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { SectionNav } from '@/components/admin/section-nav';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/admin/finance', label: 'Overview', exact: true },
  { href: '/admin/finance/invoices', label: 'Invoices' },
  { href: '/admin/finance/reconciliation', label: 'Reconciliation' },
  { href: '/admin/finance/bank-transfers', label: 'Bank transfers' },
  { href: '/admin/finance/refunds', label: 'Refunds' },
  { href: '/admin/finance/documents', label: 'Credit notes & receipts' },
  { href: '/admin/finance/exports', label: 'Exports' },
  { href: '/admin/finance/accounts', label: 'Chart of accounts' },
  { href: '/admin/finance/journals', label: 'Journals' },
  { href: '/admin/finance/payouts', label: 'Payouts' },
];

/**
 * Finance section: readable with `finance.read`. Every mutation checks its own
 * permission on the server; invoice management, reconciliation, refund
 * approval, payouts and exports also require a verified authenticator.
 */
export default async function FinanceLayout({ children }: { children: ReactNode }) {
  const identity = await requireStaffPage('finance.read');
  return (
    <div className="space-y-6">
      <SectionNav items={NAV} label="Finance sections" />
      {!identity.actor.mfaVerified ? (
        <Alert tone="warning" title="Authenticator not verified">
          You can read finance records, but issuing or voiding invoices, reconciling, confirming bank transfers, approving
          refunds or payouts and exporting all require a verified authenticator.{' '}
          <Link href="/admin/security/mfa" className="font-medium underline">
            Set up multi-factor authentication
          </Link>
          .
        </Alert>
      ) : null}
      {children}
    </div>
  );
}
