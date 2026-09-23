import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent, PageHeader } from '@simplexd/ui';
import { LoadError } from '@/components/tenant/load-error';
import { NewTicketForm } from '@/components/tenant/new-ticket-form';
import { NoTenancy } from '@/components/tenant/no-tenancy';
import { requireSignedIn } from '@/lib/auth/session';
import { isLiveLease, leaseTitle } from '@/lib/tenant/model';
import { loadMyLeases } from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Report a problem' };
export const dynamic = 'force-dynamic';

export default async function NewTenantTicketPage() {
  const identity = await requireSignedIn('/tenant/tickets/new');
  const leases = await loadMyLeases(identity);
  const header = (
    <PageHeader
      eyebrow={
        <Link href="/tenant/tickets" className="underline">
          Maintenance
        </Link>
      }
      title="Report a maintenance problem"
      description="Tell the maintenance team what needs fixing. You can follow its progress and cancel it while work has not started."
    />
  );
  if (!leases.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError title="Your leases could not be loaded" error={leases.error} />
      </div>
    );
  }
  const live = leases.data.filter((l) => isLiveLease(l.lease.status));
  if (live.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        {leases.data.length === 0 ? (
          <NoTenancy
            email={identity.session!.user.email}
            hasPortal={identity.actor.memberships.length > 0}
          />
        ) : (
          <p role="status" className="rounded-md border border-border bg-bg-sunken p-3 text-sm">
            None of your leases is active, so a new problem cannot be reported. Contact your
            landlord or property manager directly.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      <Card>
        <CardContent className="pt-5">
          <NewTicketForm leases={live.map((l) => ({ id: l.lease.id, title: leaseTitle(l) }))} />
        </CardContent>
      </Card>
    </div>
  );
}
