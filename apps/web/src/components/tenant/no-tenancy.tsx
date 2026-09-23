import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@simplexd/ui';

/**
 * Honest empty state for a signed-in account with no active tenancy: not an
 * error, just nothing shared with this account yet, and how that changes.
 */
export function NoTenancy({
  email,
  hasPortal,
  title = 'No tenancy on this account yet',
}: {
  email: string;
  hasPortal: boolean;
  title?: string;
}) {
  return (
    <EmptyState
      icon={<KeyRound aria-hidden="true" className="h-8 w-8" />}
      title={title}
      description={
        <>
          Lease details, balances, receipts and maintenance appear here once a landlord or property
          manager invites you to a lease and you accept. The invitation arrives by email with a
          link; open it while signed in as <strong>{email}</strong>. If you were invited under a
          different address, sign in with that one instead. Access ends if the landlord revokes it.
        </>
      }
      action={
        <div className="flex flex-col gap-2 sm:flex-row">
          {hasPortal ? (
            <Link
              href="/portal"
              className="sx-touch inline-flex items-center justify-center rounded-md border border-border-strong px-4 text-sm font-medium"
            >
              Go to your customer portal
            </Link>
          ) : null}
          <Link
            href="/contact"
            className="sx-touch inline-flex items-center justify-center rounded-md px-4 text-sm font-medium text-primary underline"
          >
            Contact SimplexD
          </Link>
        </div>
      }
    />
  );
}
