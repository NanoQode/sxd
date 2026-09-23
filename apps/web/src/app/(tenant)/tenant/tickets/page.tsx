import { Wrench } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader } from '@simplexd/ui';
import { LinkButton } from '@/components/portal/link-button';
import { LoadError } from '@/components/tenant/load-error';
import { NoTenancy } from '@/components/tenant/no-tenancy';
import { TicketList } from '@/components/tenant/ticket-list';
import { requireSignedIn } from '@/lib/auth/session';
import { isLiveLease, isOpenTicket, leaseTitle } from '@/lib/tenant/model';
import { loadMyLeases, loadTickets, zoneOf } from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Maintenance' };
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Problems you reported in your home and where each one stands. Only requests you reported are listed.';

export default async function TenantTicketsPage() {
  const identity = await requireSignedIn('/tenant/tickets');
  const zone = zoneOf(identity);
  const [leases, tickets] = await Promise.all([loadMyLeases(identity), loadTickets(identity)]);
  const canReport = leases.ok && leases.data.some((l) => isLiveLease(l.lease.status));
  const header = (
    <PageHeader
      eyebrow={
        <Link href="/tenant" className="underline">
          Tenant home
        </Link>
      }
      title="Maintenance"
      description={DESCRIPTION}
      actions={
        canReport ? <LinkButton href="/tenant/tickets/new">Report a problem</LinkButton> : undefined
      }
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
  if (leases.data.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <NoTenancy
          email={identity.session!.user.email}
          hasPortal={identity.actor.memberships.length > 0}
        />
      </div>
    );
  }
  const leaseTitles =
    leases.data.length > 1
      ? Object.fromEntries(leases.data.map((l) => [l.lease.id, leaseTitle(l)]))
      : undefined;
  const open = tickets.ok ? tickets.data.filter(isOpenTicket) : [];
  const done = tickets.ok ? tickets.data.filter((t) => !isOpenTicket(t)) : [];
  return (
    <div className="space-y-6">
      {header}
      {!canReport ? (
        <p role="status" className="rounded-md border border-border bg-bg-sunken p-3 text-sm">
          None of your leases is active, so new problems cannot be reported here. Past requests stay
          visible below.
        </p>
      ) : null}
      {!tickets.ok ? (
        <LoadError title="Your maintenance requests could not be loaded" error={tickets.error} />
      ) : tickets.data.length === 0 ? (
        <EmptyState
          icon={<Wrench aria-hidden="true" className="h-8 w-8" />}
          title="No maintenance requests yet"
          description="Report leaks, power faults, broken fittings or security problems. The team reviews each request and arranges a contractor."
          action={
            canReport ? (
              <LinkButton href="/tenant/tickets/new">Report a problem</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <>
          <section aria-labelledby="open-heading" className="space-y-3">
            <h2 id="open-heading" className="text-lg font-semibold">
              Open ({open.length})
            </h2>
            {open.length === 0 ? (
              <p className="text-sm text-fg-muted">Nothing open right now.</p>
            ) : (
              <TicketList tickets={open} zone={zone} leaseTitles={leaseTitles} />
            )}
          </section>
          {done.length > 0 ? (
            <section aria-labelledby="done-heading" className="space-y-3">
              <h2 id="done-heading" className="text-lg font-semibold">
                Finished or cancelled ({done.length})
              </h2>
              <TicketList tickets={done} zone={zone} leaseTitles={leaseTitles} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
