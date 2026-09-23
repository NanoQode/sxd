import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leasePartyRoleSchema, rentChargeKindSchema } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { leaseWorkspace } from '@/lib/admin/server/rentals';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../../_components/bits';
import { WorkOrderCreateDialog } from '../../_components/work-order-create-dialog';

export const metadata: Metadata = { title: 'Lease' };
export const dynamic = 'force-dynamic';

const BUCKETS: Array<[string, string]> = [
  ['current', 'Not yet due'],
  ['days_1_30', '1–30 days'],
  ['days_31_60', '31–60 days'],
  ['days_61_90', '61–90 days'],
  ['days_over_90', 'Over 90 days'],
];

export default async function LeasePage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/rentals');
  const { id } = await params;
  const loaded = await attempt(() => leaseWorkspace(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This lease" />;
  }
  const { lease: l, schedule, charges, balance, workOrders, canManage } = loaded.value;
  const live = ['active', 'expiring'].includes(l.status);
  const fee =
    l.managementFeeBasis === 'percentage_of_collected'
      ? `${((l.managementFeeBps ?? 0) / 100).toFixed(2)}% of rent collected`
      : l.managementFeeBasis === 'fixed_monthly'
        ? 'fixed monthly'
        : 'none';
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/rentals" className="underline">
            Leases
          </Link>
        }
        title={`${l.propertyName ?? 'Property'}${l.unitLabel ? ` · ${l.unitLabel}` : ''}`}
        description={`${humanize(l.kind)} · ${l.organizationName} · ${formatDateLabel(l.startDate)} → ${l.endDate ? formatDateLabel(l.endDate) : 'open-ended'}`}
        actions={
          <>
            <StatusBadge
              status={
                l.status === 'active'
                  ? 'in_progress'
                  : l.status === 'expiring'
                    ? 'overdue'
                    : l.status === 'ended'
                      ? 'completed'
                      : l.status === 'terminated'
                        ? 'cancelled'
                        : l.status
              }
              label={humanize(l.status)}
            />
            {canManage && l.status === 'draft' ? (
              <ApiAction
                path={`/api/v1/leases/${l.id}/transition`}
                body={{ to: 'pending_signature', expectedVersion: l.version }}
                label="Send for signature"
                successMessage="Awaiting signature"
              />
            ) : null}
            {canManage && ['draft', 'pending_signature'].includes(l.status) ? (
              <ApiAction
                path={`/api/v1/leases/${l.id}/transition`}
                body={{ to: 'active', expectedVersion: l.version }}
                label="Activate"
                variant="primary"
                confirm={{
                  title: 'Activate this lease?',
                  description:
                    'Freezes dates, rent and period, marks the unit occupied and generates the rent schedule. Refused if another lease occupies the unit for overlapping dates.',
                  confirmLabel: 'Activate',
                }}
                successMessage="Lease active"
              />
            ) : null}
            {canManage && live ? (
              <>
                <FormDialog
                  trigger="Renew"
                  title="Renew the lease"
                  description="Creates the successor as a draft with the same parties."
                  path={`/api/v1/leases/${l.id}/renew`}
                  successMessage="Renewal drafted"
                  redirectTo="/admin/rentals/leases/{id}"
                  extraBody={{ expectedVersion: l.version }}
                  fields={[
                    { name: 'startDate', label: 'New start date', type: 'date', required: true },
                    { name: 'endDate', label: 'New end date', type: 'date', emptyAs: 'null' },
                    {
                      name: 'rentAmountKobo',
                      label: 'New rent per period (₦, blank keeps current)',
                      type: 'naira',
                    },
                  ]}
                />
                <FormDialog
                  trigger="Terminate"
                  title="Terminate the lease"
                  description="Uninvoiced periods after the date are waived; a straddling period is cut and prorated. Issued invoices stay; finance credits any unused part."
                  path={`/api/v1/leases/${l.id}/terminate`}
                  variant="ghost"
                  successMessage="Lease terminated"
                  extraBody={{ expectedVersion: l.version }}
                  fields={[
                    { name: 'reason', label: 'Reason', type: 'textarea', required: true },
                    { name: 'terminatedOn', label: 'Terminated on (default today)', type: 'date' },
                  ]}
                />
                <ApiAction
                  path={`/api/v1/leases/${l.id}/transition`}
                  body={{ to: 'ended', expectedVersion: l.version }}
                  label="End now"
                  variant="ghost"
                  confirm={{
                    title: 'End this lease?',
                    description:
                      'Normally the rent job ends it the day after the end date. Ending by hand releases the unit.',
                    confirmLabel: 'End lease',
                    tone: 'danger',
                  }}
                  successMessage="Lease ended"
                />
              </>
            ) : null}
          </>
        }
      />
      {l.terminationReason ? (
        <Alert tone="info" title="Terminated">
          {l.terminatedAt ? formatDateTimeLabel(l.terminatedAt) : ''}: {l.terminationReason}
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section
            title="Balance and arrears"
            description="Settled money only; an uploaded transfer receipt does not count until finance confirms it."
          >
            {!balance.ok ? (
              <LoadError code={balance.code} message={balance.message} what="The balance" />
            ) : (
              <>
                <DefinitionList
                  items={[
                    {
                      term: 'Charged',
                      value: (
                        <Money kobo={balance.value.chargedKobo} currency={balance.value.currency} />
                      ),
                    },
                    {
                      term: 'Paid',
                      value: (
                        <Money kobo={balance.value.paidKobo} currency={balance.value.currency} />
                      ),
                    },
                    {
                      term: 'Outstanding (incl. not yet due)',
                      value: (
                        <strong>
                          <Money
                            kobo={balance.value.outstandingKobo}
                            currency={balance.value.currency}
                          />
                        </strong>
                      ),
                    },
                    {
                      term: 'Deposit held',
                      value: (
                        <Money
                          kobo={balance.value.depositHeldKobo}
                          currency={balance.value.currency}
                        />
                      ),
                    },
                    {
                      term: 'Next due',
                      value: balance.value.nextDue ? (
                        <span>
                          {formatDateLabel(balance.value.nextDue.dueDate)} ·{' '}
                          <Money kobo={balance.value.nextDue.amountKobo} />
                        </span>
                      ) : null,
                    },
                  ]}
                />
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {BUCKETS.map(([k, label]) => {
                    const v =
                      balance.value.arrears.buckets[
                        k as keyof typeof balance.value.arrears.buckets
                      ] ?? '0';
                    return (
                      <div
                        key={k}
                        className={`rounded-md border p-2 ${k !== 'current' && v !== '0' ? 'border-danger/50' : 'border-border'}`}
                      >
                        <p className="text-xs text-fg-muted">{label}</p>
                        <Money kobo={v} />
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-fg-muted">
                  Arrears as of {formatDateLabel(balance.value.arrears.asOf)}:{' '}
                  <Money kobo={balance.value.arrears.totalOutstandingKobo} /> outstanding.
                </p>
              </>
            )}
          </Section>
          <Section
            title="Charges"
            actions={
              canManage && live ? (
                <FormDialog
                  trigger="Add charge"
                  title="Add a charge"
                  description="Late fees, utilities and other charges ride on the next rent invoice."
                  path={`/api/v1/leases/${l.id}/charges`}
                  successMessage="Charge added"
                  fields={[
                    {
                      name: 'kind',
                      label: 'Kind',
                      type: 'select',
                      required: true,
                      options: rentChargeKindSchema.options
                        .filter((k) => k !== 'rent')
                        .map((k) => ({ value: k, label: humanize(k) })),
                    },
                    { name: 'amountKobo', label: 'Amount (₦)', type: 'naira', required: true },
                    { name: 'description', label: 'Description', required: true, wide: true },
                    { name: 'chargedAt', label: 'Charge date (default today)', type: 'date' },
                  ]}
                />
              ) : undefined
            }
          >
            {!charges.ok ? (
              <LoadError code={charges.code} message={charges.message} what="Charges" />
            ) : (
              <DataTable
                caption="Charges with balances"
                rows={charges.value}
                rowKey={(c) => c.id}
                rowLabel={(c) => c.description}
                emptyMessage="No charges yet; they appear when the lease is activated."
                columns={[
                  {
                    key: 'd',
                    header: 'Charge',
                    cell: (c) => (
                      <span>
                        {c.description}
                        <span className="block text-xs text-fg-muted">
                          {humanize(c.kind)} · {formatDateLabel(c.chargedAt)}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'a',
                    header: 'Amount',
                    cell: (c) => <Money kobo={c.amountKobo} currency={l.currency} />,
                  },
                  {
                    key: 'p',
                    header: 'Paid',
                    cell: (c) => <Money kobo={c.paidKobo} currency={l.currency} />,
                    hideOnMobile: true,
                  },
                  {
                    key: 'o',
                    header: 'Outstanding',
                    cell: (c) =>
                      c.outstandingKobo === '0' ? (
                        <Badge tone="success">settled</Badge>
                      ) : (
                        <Money kobo={c.outstandingKobo} currency={l.currency} />
                      ),
                  },
                  {
                    key: 'i',
                    header: 'Invoice',
                    cell: (c) =>
                      c.invoiceId ? (
                        <Link href={`/admin/finance/invoices/${c.invoiceId}`} className="underline">
                          open
                        </Link>
                      ) : (
                        <span className="text-xs text-fg-muted">not invoiced</span>
                      ),
                    hideOnMobile: true,
                  },
                ]}
              />
            )}
          </Section>
          <Section title="Rent schedule">
            {!schedule.ok ? (
              <LoadError code={schedule.code} message={schedule.message} what="The schedule" />
            ) : (
              <DataTable
                caption="Rent schedule"
                rows={schedule.value}
                rowKey={(s) => s.id}
                rowLabel={(s) => s.periodStart}
                emptyMessage="Generated on activation."
                columns={[
                  {
                    key: 'p',
                    header: 'Period',
                    cell: (s) =>
                      `${formatDateLabel(s.periodStart)} → ${formatDateLabel(s.periodEnd)}`,
                  },
                  { key: 'd', header: 'Due', cell: (s) => formatDateLabel(s.dueDate) },
                  {
                    key: 'a',
                    header: 'Amount',
                    cell: (s) => <Money kobo={s.amountKobo} currency={l.currency} />,
                  },
                  {
                    key: 's',
                    header: 'Status',
                    cell: (s) => (
                      <StatusBadge
                        status={
                          s.status === 'scheduled'
                            ? 'draft'
                            : s.status === 'invoiced'
                              ? 'issued'
                              : s.status === 'waived'
                                ? 'void'
                                : s.status
                        }
                        label={humanize(s.status)}
                      />
                    ),
                  },
                  {
                    key: 'i',
                    header: 'Invoice',
                    cell: (s) =>
                      s.invoiceId ? (
                        <Link href={`/admin/finance/invoices/${s.invoiceId}`} className="underline">
                          open
                        </Link>
                      ) : (
                        '—'
                      ),
                    hideOnMobile: true,
                  },
                ]}
              />
            )}
          </Section>
          <Section
            title="Maintenance on this lease"
            actions={
              canManage ? (
                <WorkOrderCreateDialog properties={[]} propertyId={l.propertyId} leaseId={l.id} />
              ) : undefined
            }
          >
            {!workOrders.ok ? (
              <LoadError code={workOrders.code} message={workOrders.message} what="Work orders" />
            ) : workOrders.value.length === 0 ? (
              <p className="text-fg-muted">No work orders.</p>
            ) : (
              <ul className="space-y-1">
                {workOrders.value.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/admin/rentals/work-orders/${w.id}`} className="underline">
                      {w.title}
                    </Link>
                    <span className="flex items-center gap-2">
                      {w.slaBreached ? <Badge tone="danger">SLA breached</Badge> : null}
                      <Badge>{humanize(w.status)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <Section title="Terms">
            <DefinitionList
              items={[
                {
                  term: 'Rent',
                  value: (
                    <span>
                      <Money kobo={l.rentAmountKobo} currency={l.currency} /> per {l.rentPeriod}
                    </span>
                  ),
                },
                { term: 'Deposit', value: <Money kobo={l.depositKobo} currency={l.currency} /> },
                {
                  term: 'Management fee',
                  value:
                    l.managementFeeBasis === 'fixed_monthly' ? (
                      <span>
                        <Money kobo={l.managementFeeFixedKobo} currency={l.currency} /> monthly
                      </span>
                    ) : (
                      fee
                    ),
                },
                {
                  term: 'Service charge',
                  value: l.terms?.serviceChargeKobo ? (
                    <Money kobo={l.terms.serviceChargeKobo} currency={l.currency} />
                  ) : null,
                },
                { term: 'Due lead (days)', value: l.terms?.dueLeadDays ?? 0 },
                {
                  term: 'Notice period',
                  value: l.noticePeriodDays ? `${l.noticePeriodDays} days` : 'default 30 days',
                },
                { term: 'Academic period', value: l.academicPeriod },
                {
                  term: 'Property',
                  value: (
                    <Link href={`/admin/properties/${l.propertyId}`} className="underline">
                      open property
                    </Link>
                  ),
                },
                { term: 'Version', value: l.version },
              ]}
            />
          </Section>
          <Section
            title="Parties"
            description="Invitations are single-use and expire; revocation removes access immediately."
            actions={
              canManage && l.status !== 'terminated' && l.status !== 'ended' ? (
                <FormDialog
                  trigger="Invite party"
                  title="Invite a tenant or other party"
                  path={`/api/v1/leases/${l.id}/parties`}
                  successMessage="Invitation sent"
                  fields={[
                    {
                      name: 'role',
                      label: 'Role',
                      type: 'select',
                      required: true,
                      options: leasePartyRoleSchema.options.map((r) => ({
                        value: r,
                        label: humanize(r),
                      })),
                    },
                    { name: 'name', label: 'Name', required: true },
                    { name: 'email', label: 'Email', required: true },
                    { name: 'phoneE164', label: 'Phone (+234…)' },
                    {
                      name: 'expiresInDays',
                      label: 'Invitation valid (days)',
                      type: 'number',
                      min: 1,
                      max: 30,
                      defaultValue: 7,
                    },
                  ]}
                />
              ) : undefined
            }
          >
            {l.parties.length === 0 ? <p className="text-fg-muted">No parties.</p> : null}
            <ul className="space-y-2">
              {l.parties.map((p) => (
                <li key={p.id} className="rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {p.name} <Badge>{humanize(p.role)}</Badge>
                    </span>
                    <Badge
                      tone={
                        p.accessStatus === 'active'
                          ? 'success'
                          : p.accessStatus === 'invited'
                            ? 'info'
                            : p.accessStatus === 'revoked' || p.accessStatus === 'expired'
                              ? 'danger'
                              : 'neutral'
                      }
                    >
                      {humanize(p.accessStatus)}
                    </Badge>
                  </div>
                  <p className="text-xs text-fg-muted">
                    {p.email ?? ''}
                    {p.invitationExpiresAt && p.accessStatus === 'invited'
                      ? ` · invitation expires ${formatDateTimeLabel(p.invitationExpiresAt)}`
                      : ''}
                  </p>
                  {canManage && ['invited', 'active'].includes(p.accessStatus) ? (
                    <ApiAction
                      path={`/api/v1/leases/${l.id}/parties/${p.id}/revoke`}
                      reasonKey="reason"
                      label="Revoke access"
                      variant="ghost"
                      confirm={{
                        title: `Revoke ${p.name}'s access?`,
                        requireReason: true,
                        confirmLabel: 'Revoke',
                        tone: 'danger',
                      }}
                      successMessage="Access revoked"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
          {canManage && live ? (
            <Section title="Notice to tenants">
              <FormDialog
                trigger="Post a notice"
                title="Post a notice"
                description="Active tenants see approved notices on their lease and get an in-app notification."
                path={`/api/v1/leases/${l.id}/notices`}
                successMessage="Notice posted"
                fields={[
                  { name: 'title', label: 'Title', required: true, wide: true },
                  { name: 'body', label: 'Notice', type: 'textarea', required: true },
                ]}
              />
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
