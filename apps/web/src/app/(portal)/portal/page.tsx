import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  formatDateTimeLabel,
  formatNairaString,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { loadHomeCards } from '@/server/portal/home';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

function KpiCard({
  title,
  value,
  description,
  href,
  linkLabel,
  children,
}: {
  title: string;
  value: string;
  description: string;
  href: string;
  linkLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-fg-muted">{title}</CardTitle>
        <p className="font-display text-3xl font-semibold leading-none">{value}</p>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {children}
        <Link href={href} className="sx-touch inline-flex items-center text-sm font-medium text-primary underline">
          {linkLabel}
        </Link>
      </CardContent>
    </Card>
  );
}

export default async function PortalHomePage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const identity = await requireSignedIn('/portal');
  const params = await searchParams;
  const cards = await loadHomeCards(identity);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const hasOrg = Boolean(identity.ctx.organizationId);
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${identity.session!.user.name.split(' ')[0]}`}
        description="What changed, what needs you, what is due and what happens next. Every figure opens its records."
        actions={
          hasOrg ? (
            <Link href="/portal/requests/new" className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary hover:bg-primary-hover">
              Request a service
            </Link>
          ) : undefined
        }
      />
      {params.denied === 'admin' ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm">
          You do not have permission to open the admin console. Your customer portal is shown instead.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          title="Tasks awaiting your approval"
          value={String(cards.approvalsPending.count)}
          description={
            cards.approvalsPending.count === 0
              ? 'Nothing needs your decision right now. Approvals appear when a change order, milestone or quote is waiting on you.'
              : 'Change orders, milestones or quotes are waiting for your decision.'
          }
          href={cards.approvalsPending.href}
          linkLabel="Open projects"
        />
        <KpiCard
          title="Upcoming visits"
          value={String(cards.upcomingVisits.count)}
          description={
            cards.upcomingVisits.next
              ? `Next: ${humanize(cards.upcomingVisits.next.kind)} on ${formatDateTimeLabel(cards.upcomingVisits.next.startsAt, zone)}`
              : 'No visits or consultations are scheduled. Book one when an engagement needs a site visit.'
          }
          href={cards.upcomingVisits.href}
          linkLabel="See appointments"
        />
        <KpiCard
          title="Invoices due"
          value={String(cards.invoicesDue.count)}
          description={
            cards.invoicesDue.count === 0
              ? 'No invoices are outstanding. Invoices are issued after you accept a quotation.'
              : `${formatNairaString(cards.invoicesDue.outstandingKobo)} outstanding across issued invoices.`
          }
          href={cards.invoicesDue.href}
          linkLabel="View invoices"
        />
        <KpiCard
          title="Latest released reports"
          value={String(cards.latestReports.items.length)}
          description={
            cards.latestReports.items.length === 0
              ? 'Reports appear here once a reviewer releases them for your engagement.'
              : 'Reviewed and released reports for your organisation.'
          }
          href={cards.latestReports.href}
          linkLabel="Open documents"
        >
          {cards.latestReports.items.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {cards.latestReports.items.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{r.title}</span>
                  <Badge tone="success">{humanize(r.kind)}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </KpiCard>
        <KpiCard
          title="Budget changes"
          value={String(cards.budgetChanges.count)}
          description={
            cards.budgetChanges.count === 0
              ? 'No approved change orders. Budgets only move once you and staff approve a change.'
              : `Approved change orders adjust budgets by ${formatNairaString(cards.budgetChanges.deltaKobo)} in total.`
          }
          href={cards.budgetChanges.href}
          linkLabel="Review projects"
        />
        <KpiCard
          title="Assigned contact"
          value={cards.assignedContact.name ?? '—'}
          description={
            cards.assignedContact.name
              ? `Your project contact on ${cards.assignedContact.reference}. Message the team from the Messages page.`
              : 'A project manager is assigned once a request is triaged. Until then, replies come from the operations team.'
          }
          href={cards.assignedContact.href}
          linkLabel="Open messages"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Open requests</CardTitle>
          <CardDescription>
            {cards.openRequests.count === 0
              ? 'You have no open service requests.'
              : `${cards.openRequests.count} request${cards.openRequests.count === 1 ? '' : 's'} in progress, from inquiry to delivery.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/portal/requests" className="sx-touch inline-flex items-center text-sm font-medium text-primary underline">
            View requests
          </Link>
          <Link href="/portal/scenarios" className="sx-touch inline-flex items-center text-sm font-medium text-primary underline">
            Saved scenarios
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
