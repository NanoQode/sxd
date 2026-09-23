import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@simplexd/ui';
import { LinkButton } from '@/components/portal/link-button';
import { AppointmentList } from '@/components/tenant/appointment-list';
import { LeaseCard } from '@/components/tenant/lease-card';
import { LoadError } from '@/components/tenant/load-error';
import { NoTenancy } from '@/components/tenant/no-tenancy';
import { NoticeList } from '@/components/tenant/notice-list';
import { TicketList } from '@/components/tenant/ticket-list';
import { requireSignedIn } from '@/lib/auth/session';
import {
  formatMoney,
  isLiveLease,
  isOpenTicket,
  isPositiveKobo,
  leaseTitle,
  nextDueCopy,
  overdueKobo,
  pickCurrentLease,
  splitAppointments,
  unreadCount,
} from '@/lib/tenant/model';
import {
  loadAppointments,
  loadBalance,
  loadMyLeases,
  loadNotices,
  loadTickets,
  zoneOf,
} from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

function Section({
  title,
  value,
  description,
  href,
  linkLabel,
  children,
}: {
  title: string;
  value?: string;
  description: ReactNode;
  href: string;
  linkLabel: string;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-fg-muted">{title}</CardTitle>
        {value ? <p className="font-display text-3xl leading-none font-semibold">{value}</p> : null}
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        <Link
          href={href}
          className="sx-touch inline-flex items-center text-sm font-medium text-primary underline"
        >
          {linkLabel}
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * Tenant home: the current lease, what is owed and when, open maintenance,
 * upcoming appointments and the latest notices. Each figure links to its
 * records; each section fails or empties on its own.
 */
export default async function TenantHomePage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const identity = await requireSignedIn('/tenant');
  const { welcome } = await searchParams;
  const zone = zoneOf(identity);
  const firstName = identity.session!.user.name.split(' ')[0] ?? '';
  const leases = await loadMyLeases(identity);

  const header = (actions?: ReactNode) => (
    <PageHeader
      title={`Welcome, ${firstName}`}
      description="Your lease, what is due, maintenance requests, appointments and notices from your landlord."
      actions={actions}
    />
  );

  if (!leases.ok) {
    return (
      <div className="space-y-6">
        {header()}
        <LoadError title="Your tenancy could not be loaded" error={leases.error} />
      </div>
    );
  }
  if (leases.data.length === 0) {
    return (
      <div className="space-y-6">
        {header()}
        <NoTenancy
          email={identity.session!.user.email}
          hasPortal={identity.actor.memberships.length > 0}
        />
      </div>
    );
  }

  const current = pickCurrentLease(leases.data)!;
  const others = leases.data.filter((l) => l.lease.id !== current.lease.id);
  const canReport = leases.data.some((l) => isLiveLease(l.lease.status));
  const [balance, tickets, appointments, notices] = await Promise.all([
    loadBalance(identity, current.lease.id),
    loadTickets(identity),
    loadAppointments(identity),
    loadNotices(identity),
  ]);
  const leaseTitles = Object.fromEntries(leases.data.map((l) => [l.lease.id, leaseTitle(l)]));
  const openTickets = tickets.ok ? tickets.data.filter(isOpenTicket) : [];
  const upcoming = appointments.ok ? splitAppointments(appointments.data).upcoming : [];
  const latestNotices = notices.ok ? notices.data.slice(0, 3) : [];
  const nextDue = balance.ok ? nextDueCopy(balance.data.nextDue, balance.data.arrears.asOf) : null;

  return (
    <div className="space-y-6">
      {header(
        canReport ? (
          <LinkButton href="/tenant/tickets/new">Report a maintenance problem</LinkButton>
        ) : undefined,
      )}
      {welcome === '1' ? (
        <Alert tone="success" title="Invitation accepted">
          Your lease is now linked to this account. Balances, receipts and notices for it appear
          below.
        </Alert>
      ) : null}

      <LeaseCard summary={current} heading={others.length > 0 ? 'Current lease' : 'Your lease'} />
      {others.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-fg-muted">Your other leases</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {others.map((l) => (
                <li key={l.lease.id}>
                  <Link
                    href={`/tenant/lease/${l.lease.id}`}
                    className="sx-touch inline-flex items-center text-primary underline"
                  >
                    {leaseTitle(l)} ({l.lease.status.replace(/_/g, ' ')})
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {balance.ok ? (
          <Section
            title="Balance due"
            value={formatMoney(balance.data.outstandingKobo, balance.data.currency)}
            description={
              isPositiveKobo(overdueKobo(balance.data.arrears))
                ? `${formatMoney(overdueKobo(balance.data.arrears), balance.data.currency)} of this is past its due date.`
                : isPositiveKobo(balance.data.outstandingKobo)
                  ? 'Nothing is overdue.'
                  : 'No rent or other charges are unpaid on this lease.'
            }
            href={`/tenant/balances?lease=${current.lease.id}`}
            linkLabel="See charges and arrears"
          >
            <p className="text-sm">
              {nextDue ? (
                <>
                  <span className="text-fg-muted">{nextDue.label}: </span>
                  <strong>
                    {formatMoney(balance.data.nextDue!.amountKobo, balance.data.currency)}{' '}
                    {nextDue.when}
                  </strong>
                </>
              ) : (
                <span className="text-fg-muted">No further charge is scheduled.</span>
              )}
            </p>
          </Section>
        ) : (
          <LoadError title="Your balance could not be loaded" error={balance.error} />
        )}

        {tickets.ok ? (
          <Section
            title="Open maintenance requests"
            value={String(openTickets.length)}
            description={
              openTickets.length === 0
                ? 'Nothing open. Report a problem when something in your home needs fixing.'
                : 'Requests you reported that are not finished yet.'
            }
            href="/tenant/tickets"
            linkLabel="All maintenance requests"
          >
            {openTickets.length > 0 ? (
              <TicketList
                tickets={openTickets.slice(0, 3)}
                zone={zone}
                leaseTitles={others.length > 0 ? leaseTitles : undefined}
              />
            ) : null}
          </Section>
        ) : (
          <LoadError title="Your maintenance requests could not be loaded" error={tickets.error} />
        )}

        {appointments.ok ? (
          <Section
            title="Upcoming appointments"
            value={String(upcoming.length)}
            description={
              upcoming.length === 0
                ? 'No visits are booked with you. Inspections and repair visits appear here when scheduled.'
                : 'Visits booked with you.'
            }
            href="/tenant/appointments"
            linkLabel="All appointments"
          >
            {upcoming.length > 0 ? (
              <AppointmentList appointments={upcoming.slice(0, 2)} zone={zone} />
            ) : null}
          </Section>
        ) : (
          <LoadError title="Your appointments could not be loaded" error={appointments.error} />
        )}

        {notices.ok ? (
          <Section
            title="Latest notices"
            value={unreadCount(notices.data) > 0 ? `${unreadCount(notices.data)} new` : undefined}
            description={
              notices.data.length === 0
                ? 'No notices yet. Your landlord or SimplexD posts notices about your lease here.'
                : 'Notices from your landlord or SimplexD about your lease.'
            }
            href="/tenant/notices"
            linkLabel="All notices"
          >
            {latestNotices.length > 0 ? (
              <NoticeList notices={latestNotices} zone={zone} leaseTitles={leaseTitles} compact />
            ) : null}
          </Section>
        ) : (
          <LoadError title="Your notices could not be loaded" error={notices.error} />
        )}
      </div>
    </div>
  );
}
