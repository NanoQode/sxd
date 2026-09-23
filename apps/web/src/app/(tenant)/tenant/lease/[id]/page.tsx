import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { uuidSchema, type MoveInInventoryDto } from '@simplexd/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { SignedDownloadButton } from '@/components/portal/signed-download';
import { ScheduleTable } from '@/components/tenant/ledger-tables';
import { LoadError } from '@/components/tenant/load-error';
import { LeaseStatusBadge } from '@/components/tenant/status';
import { requireSignedIn } from '@/lib/auth/session';
import {
  LEASE_KIND_LABELS,
  LEASE_STATUS_COPY,
  RENT_PERIOD_LABELS,
  formatAddress,
  formatDay,
  formatMoney,
  leaseTitle,
} from '@/lib/tenant/model';
import {
  loadLease,
  loadMyParty,
  loadSchedule,
  visibleFiles,
  zoneOf,
} from '@/lib/tenant/server/data';
import { isNotFound } from '@/lib/tenant/server/load';

export const metadata: Metadata = { title: 'Lease' };
export const dynamic = 'force-dynamic';

function NotYours() {
  return (
    <div className="space-y-6">
      <PageHeader title="Lease not found" />
      <EmptyState
        tone="warning"
        title="This lease is not available to you"
        description="It does not exist, or your access to it has ended (for example, the landlord revoked it). Leases you are an active party to are listed on your tenant home."
        action={
          <Link
            href="/tenant"
            className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
          >
            Tenant home
          </Link>
        }
      />
    </div>
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-fg-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * One of the caller's leases: terms, the caller's own party record, the rent
 * schedule, documents the file policy lets them open and the move-in
 * inventory. Owner-only terms (management fees) never reach this page.
 */
export default async function TenantLeasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireSignedIn(`/tenant/lease/${id}`);
  if (!uuidSchema.safeParse(id).success) return <NotYours />;
  const zone = zoneOf(identity);
  const summary = await loadLease(identity, id);
  if (!summary.ok) {
    if (isNotFound(summary)) return <NotYours />;
    return (
      <div className="space-y-6">
        <PageHeader title="Lease" />
        <LoadError title="This lease could not be loaded" error={summary.error} />
      </div>
    );
  }
  const { lease } = summary.data;
  const terms = lease.terms ?? null;
  const inventory: MoveInInventoryDto | null =
    (terms?.moveInInventory as MoveInInventoryDto) ?? null;
  const inventoryPhotoIds = inventory ? inventory.items.flatMap((i) => i.photoFileIds ?? []) : [];
  const [schedule, party, termsFile, photos] = await Promise.all([
    loadSchedule(identity, id),
    loadMyParty(identity, id),
    lease.termsFileId ? visibleFiles(identity, [lease.termsFileId]) : null,
    inventoryPhotoIds.length > 0 ? visibleFiles(identity, inventoryPhotoIds) : null,
  ]);
  const address = formatAddress(summary.data.property.address);
  const rooms = inventory
    ? Array.from(
        inventory.items.reduce((map, item) => {
          const list = map.get(item.room) ?? [];
          list.push(item);
          map.set(item.room, list);
          return map;
        }, new Map<string, MoveInInventoryDto['items']>()),
      )
    : [];
  const visiblePhotos = new Map((photos?.visible ?? []).map((f) => [f.id, f]));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenant" className="underline">
            Tenant home
          </Link>
        }
        title={leaseTitle(summary.data)}
        description={address ?? undefined}
        actions={<LeaseStatusBadge status={lease.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Terms</CardTitle>
          <CardDescription>{LEASE_STATUS_COPY[lease.status]}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Term label="Rent">
              <strong>{formatMoney(lease.rentAmountKobo, lease.currency)}</strong>{' '}
              {RENT_PERIOD_LABELS[lease.rentPeriod] ?? lease.rentPeriod}
            </Term>
            <Term label="Deposit">{formatMoney(lease.depositKobo, lease.currency)}</Term>
            {terms?.serviceChargeKobo ? (
              <Term label="Service charge">
                {formatMoney(terms.serviceChargeKobo, lease.currency)}{' '}
                {RENT_PERIOD_LABELS[lease.rentPeriod] ?? ''}, invoiced with the rent
              </Term>
            ) : null}
            <Term label="Starts">{formatDay(lease.startDate)}</Term>
            <Term label="Ends">{lease.endDate ? formatDay(lease.endDate) : 'Open-ended'}</Term>
            <Term label="Type">{LEASE_KIND_LABELS[lease.kind] ?? lease.kind}</Term>
            {/* The tenant view carries these only when shared; otherwise the schedule shows due dates. */}
            {terms?.dueLeadDays !== undefined ? (
              <Term label="Rent due">
                {terms.dueLeadDays > 0
                  ? `${terms.dueLeadDays} days before each period starts`
                  : 'On the first day of each period'}
              </Term>
            ) : (
              <Term label="Rent due">See the due date of each period in the schedule below</Term>
            )}
            {terms?.prorate !== undefined ? (
              <Term label="Part periods">
                {terms.prorate ? 'Charged by the number of days (prorated)' : 'Charged in full'}
              </Term>
            ) : null}
            {lease.noticePeriodDays !== null ? (
              <Term label="Notice period">{lease.noticePeriodDays} days</Term>
            ) : null}
            {lease.academicPeriod ? (
              <Term label="Academic period">{lease.academicPeriod}</Term>
            ) : null}
            {lease.terminatedAt ? (
              <Term label="Terminated">
                {formatDateTimeLabel(lease.terminatedAt, zone)}
                {lease.terminationReason ? ` · ${lease.terminationReason}` : ''}
              </Term>
            ) : null}
          </dl>
          {terms?.academicTerms && terms.academicTerms.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-medium">Academic terms</h3>
              <ul className="space-y-1 text-sm">
                {terms.academicTerms.map((t) => (
                  <li key={`${t.label}-${t.start}`}>
                    {t.label}: {formatDay(t.start)} – {formatDay(t.end)}
                    {t.amountKobo ? ` · ${formatMoney(t.amountKobo, lease.currency)}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Parties</CardTitle>
          <CardDescription>
            Only your own party record is shared with you; other occupants and the landlord&apos;s
            details are kept private.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {party.ok ? (
            party.data ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                <Term label="You">{party.data.name}</Term>
                <Term label="Role">
                  <Badge tone="primary">{humanize(party.data.role)}</Badge>
                </Term>
                <Term label="Access since">
                  {party.data.acceptedAt ? formatDateTimeLabel(party.data.acceptedAt, zone) : '—'}
                </Term>
              </dl>
            ) : (
              <p className="text-sm text-fg-muted">
                Your party record is not available. Your access to this lease is still active.
              </p>
            )
          ) : (
            <LoadError title="Your party record could not be loaded" error={party.error} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rent schedule</CardTitle>
          <CardDescription>
            Each rent period, its due date and whether it has been invoiced or paid. Amounts owed
            right now are on{' '}
            <Link href={`/tenant/balances?lease=${lease.id}`} className="text-primary underline">
              Balances
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {schedule.ok ? (
            <ScheduleTable schedule={schedule.data} currency={lease.currency} />
          ) : (
            <LoadError title="The rent schedule could not be loaded" error={schedule.error} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            Files are opened through short-lived links; access is checked each time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!lease.termsFileId ? (
            <p className="text-fg-muted">
              No signed lease document has been attached to this lease yet.
            </p>
          ) : termsFile && termsFile.visible[0] ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
              <span className="min-w-0 break-words">
                Signed lease · {termsFile.visible[0].name}
              </span>
              <SignedDownloadButton
                fileId={termsFile.visible[0].id}
                fileName={termsFile.visible[0].name}
                status={termsFile.visible[0].status}
                size="md"
              />
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border bg-bg-sunken p-3 text-fg-muted">
              A signed lease document is on file, but it has not been shared with your account. Ask
              your landlord or property manager to share it with you.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Move-in inventory</CardTitle>
          <CardDescription>
            {inventory
              ? `Recorded ${formatDateTimeLabel(inventory.recordedAt, zone)}. ${
                  inventory.tenantAcknowledgedAt
                    ? `Acknowledged ${formatDateTimeLabel(inventory.tenantAcknowledgedAt, zone)}.`
                    : 'Not marked as acknowledged by the tenant.'
                }`
              : 'The condition of the home and its contents when you moved in.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!inventory ? (
            <p className="text-sm text-fg-muted">
              No move-in inventory was recorded for this lease.
            </p>
          ) : (
            <>
              {rooms.map(([room, items]) => (
                <section key={room} aria-label={room}>
                  <h3 className="mb-2 text-sm font-medium">{room}</h3>
                  <ul className="space-y-2">
                    {items.map((item, index) => (
                      <li
                        key={`${room}-${item.item}-${index}`}
                        className="rounded-md border border-border p-3 text-sm"
                      >
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.item}</span>
                          <Badge
                            tone={
                              item.condition === 'damaged' || item.condition === 'poor'
                                ? 'warning'
                                : 'neutral'
                            }
                          >
                            {humanize(item.condition)}
                          </Badge>
                        </p>
                        {item.note ? <p className="mt-1 text-fg-muted">{item.note}</p> : null}
                        {item.photoFileIds.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.photoFileIds.map((fileId, i) => {
                              const file = visiblePhotos.get(fileId);
                              return file ? (
                                <SignedDownloadButton
                                  key={fileId}
                                  fileId={file.id}
                                  fileName={file.name}
                                  status={file.status}
                                  inline
                                  size="md"
                                  label={`Photo ${i + 1}`}
                                />
                              ) : null;
                            })}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {photos && photos.hidden > 0 ? (
                <p className="text-xs text-fg-muted">
                  {photos.hidden} inventory photo{photos.hidden === 1 ? ' is' : 's are'} held by
                  your landlord and not shared with your account.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
