import type { Metadata } from 'next';
import Link from 'next/link';
import { uuidSchema } from '@simplexd/contracts';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  formatDateTimeLabel,
} from '@simplexd/ui';
import { SignedDownloadButton } from '@/components/portal/signed-download';
import { CancelTicket } from '@/components/tenant/cancel-ticket';
import { LoadError } from '@/components/tenant/load-error';
import { PriorityBadge, TicketStatusBadge } from '@/components/tenant/status';
import { TicketProgress } from '@/components/tenant/ticket-progress';
import { requireSignedIn } from '@/lib/auth/session';
import { canTenantCancel, categoryLabel, isOpenTicket, leaseTitle } from '@/lib/tenant/model';
import {
  loadMyLeases,
  loadTicket,
  userIdOf,
  visibleFiles,
  zoneOf,
} from '@/lib/tenant/server/data';
import { isNotFound } from '@/lib/tenant/server/load';

export const metadata: Metadata = { title: 'Maintenance request' };
export const dynamic = 'force-dynamic';

function NotYours() {
  return (
    <div className="space-y-6">
      <PageHeader title="Request not found" />
      <EmptyState
        tone="warning"
        title="This maintenance request is not available to you"
        description="Only requests you reported on a lease you are still an active party to are shown here."
        action={
          <Link
            href="/tenant/tickets"
            className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
          >
            Your maintenance requests
          </Link>
        }
      />
    </div>
  );
}

/**
 * One request the caller reported: status in plain words, progress,
 * recorded dates, and cancel while the workflow still allows it. Costs,
 * estimates and the owner's approvals of money are owner matters and are not
 * shown here.
 */
export default async function TenantTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireSignedIn(`/tenant/tickets/${id}`);
  if (!uuidSchema.safeParse(id).success) return <NotYours />;
  const zone = zoneOf(identity);
  const leases = await loadMyLeases(identity);
  if (!leases.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="Maintenance request" />
        <LoadError title="Your leases could not be loaded" error={leases.error} />
      </div>
    );
  }
  const ticket = await loadTicket(
    identity,
    id,
    leases.data.map((l) => l.lease.id),
  );
  if (!ticket.ok) {
    if (isNotFound(ticket)) return <NotYours />;
    return (
      <div className="space-y-6">
        <PageHeader title="Maintenance request" />
        <LoadError title="This request could not be loaded" error={ticket.error} />
      </div>
    );
  }
  const t = ticket.data;
  const lease = leases.data.find((l) => l.lease.id === t.leaseId);
  const evidence = t.evidence.length > 0 ? await visibleFiles(identity, t.evidence.map((e) => e.fileId)) : null;
  const cancellable = canTenantCancel(t, userIdOf(identity));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenant/tickets" className="underline">
            Maintenance
          </Link>
        }
        title={t.title}
        description={lease ? leaseTitle(lease) : undefined}
        actions={cancellable ? <CancelTicket ticketId={t.id} version={t.version} title={t.title} /> : undefined}
      />
      <div className="flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={t.status} />
        <PriorityBadge priority={t.priority} />
      </div>
      {t.slaBreached && isOpenTicket(t) ? (
        <Alert tone="warning" title="Response target passed">
          The maintenance team has been alerted that this request is past its response target
          {t.slaDueAt ? ` (${formatDateTimeLabel(t.slaDueAt, zone)})` : ''}.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
          {t.slaDueAt && isOpenTicket(t) && !t.slaBreached ? (
            <CardDescription>
              Response target: {formatDateTimeLabel(t.slaDueAt, zone)}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          <TicketProgress ticket={t} zone={zone} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What you reported</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-fg-muted">Category</dt>
              <dd>{categoryLabel(t.category)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Reported</dt>
              <dd>{formatDateTimeLabel(t.createdAt, zone)}</dd>
            </div>
            {t.assigneeName ? (
              <div>
                <dt className="text-fg-muted">Contractor</dt>
                <dd>{t.assigneeName}</dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="text-fg-muted">Description</dt>
              <dd className="whitespace-pre-wrap">{t.description ?? 'No description given.'}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {evidence ? (
        <Card>
          <CardHeader>
            <CardTitle>Photos and documents from the work</CardTitle>
            <CardDescription>Attached by the contractor or the maintenance team.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {evidence.visible.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {evidence.visible.map((f) => (
                  <li key={f.id}>
                    <SignedDownloadButton
                      fileId={f.id}
                      fileName={f.name}
                      status={f.status}
                      inline
                      size="md"
                      label={f.name}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {evidence.hidden > 0 ? (
              <p className="text-fg-muted">
                {evidence.hidden} file{evidence.hidden === 1 ? ' is' : 's are'} kept by the
                property owner and not shared with your account.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {!cancellable && isOpenTicket(t) ? (
        <p className="text-sm text-fg-muted">
          Work has started, so this request can no longer be cancelled here. Contact your property
          manager if it is no longer needed.
        </p>
      ) : null}
    </div>
  );
}
