import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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
import { requireStaffPage } from '@/lib/auth/session';
import { getCustomerOrganization } from '@/lib/admin/server/customers';
import { listOrganizationRequests } from '@/lib/admin/server/service-requests';
import { Money } from '@/components/admin/money';
import { GapNotice, Section } from '@/components/admin/section';
import { DefinitionList } from '../../_components/bits';
import { SupportEscalation } from './_components/support-escalation';

export const metadata: Metadata = { title: 'Customer' };
export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireStaffPage('customers.read');
  const { id } = await params;
  const view = await getCustomerOrganization(identity, id);
  if (!view) notFound();
  const requests = await listOrganizationRequests(identity, id).catch(() => []);
  const org = view.organization;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/customers" className="underline">
            Customers
          </Link>
        }
        title={org.name}
        description={`${humanize(org.kind)} organisation · ${org.slug} · since ${formatDateLabel(org.createdAt)}`}
      />
      {!view.sensitiveVisible ? (
        <Alert tone="info" title="Sensitive fields are masked">
          Emails, phone numbers and addresses are partially hidden because your role does not hold
          customers.read_sensitive.
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section title="Profile">
            <DefinitionList
              items={[
                { term: 'Legal name', value: org.legalName },
                {
                  term: 'Ownership',
                  value: org.ownershipType ? humanize(org.ownershipType) : null,
                },
                { term: 'Country', value: org.countryCode },
                { term: 'Time zone', value: org.defaultTimeZone },
                { term: 'Tax id', value: org.taxIdMasked },
                {
                  term: 'Address',
                  value: org.address
                    ? JSON.stringify(org.address)
                    : view.sensitiveVisible
                      ? null
                      : 'masked',
                },
              ]}
            />
          </Section>

          <Section
            title={`Members (${view.members.length})`}
            description="Organisation roles decide what each member may approve or pay."
          >
            <DataTable
              caption="Members"
              rows={view.members}
              rowKey={(m) => m.id}
              rowLabel={(m) => m.name}
              columns={[
                { key: 'name', header: 'Name', cell: (m) => m.name },
                { key: 'email', header: 'Email', cell: (m) => m.email },
                { key: 'phone', header: 'Phone', cell: (m) => m.phone ?? '—', hideOnMobile: true },
                {
                  key: 'role',
                  header: 'Role',
                  cell: (m) => (
                    <Badge tone={m.role === 'owner' ? 'primary' : 'neutral'}>
                      {humanize(m.role)}
                    </Badge>
                  ),
                },
                {
                  key: 'security',
                  header: 'Account',
                  cell: (m) => (
                    <span className="flex flex-wrap gap-1">
                      <Badge tone={m.emailVerified ? 'success' : 'warning'}>
                        {m.emailVerified ? 'email verified' : 'unverified'}
                      </Badge>
                      {m.twoFactorEnabled ? <Badge tone="success">2FA</Badge> : null}
                      {m.banned ? <Badge tone="danger">banned</Badge> : null}
                    </span>
                  ),
                },
                {
                  key: 'since',
                  header: 'Joined',
                  cell: (m) => formatDateLabel(m.createdAt),
                  hideOnMobile: true,
                },
              ]}
            />
            {view.invitations.length > 0 ? (
              <p className="text-fg-muted">
                Pending invitations:{' '}
                {view.invitations.map((i) => `${i.email} (${humanize(i.role)})`).join(', ')}
              </p>
            ) : null}
          </Section>

          <Section
            title={`Service requests (${requests.length})`}
            actions={
              <Link
                href={`/admin/service-requests?q=${encodeURIComponent(org.name)}`}
                className="text-sm underline"
              >
                Queue
              </Link>
            }
          >
            <DataTable
              caption="Requests"
              rows={requests}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.reference}
              emptyMessage="No requests from this organisation."
              columns={[
                {
                  key: 'ref',
                  header: 'Request',
                  cell: (r) => (
                    <Link href={`/admin/service-requests/${r.id}`} className="underline">
                      {r.reference} · {r.title}
                    </Link>
                  ),
                },
                { key: 'service', header: 'Service', cell: (r) => r.serviceName },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                {
                  key: 'pm',
                  header: 'PM',
                  cell: (r) => r.assignedPm?.name ?? '—',
                  hideOnMobile: true,
                },
                {
                  key: 'updated',
                  header: 'Updated',
                  cell: (r) => formatDateTimeLabel(r.updatedAt),
                  hideOnMobile: true,
                },
              ]}
            />
          </Section>

          <Section
            title={`Properties (${view.properties.length})`}
            actions={
              <Link
                href={`/admin/properties?organizationId=${org.id}`}
                className="text-sm underline"
              >
                All properties
              </Link>
            }
          >
            <DataTable
              caption="Properties"
              rows={view.properties}
              rowKey={(p) => p.id}
              rowLabel={(p) => p.name}
              emptyMessage="No private properties recorded."
              columns={[
                {
                  key: 'name',
                  header: 'Property',
                  cell: (p) => (
                    <Link href={`/admin/properties/${p.id}`} className="underline">
                      {p.name}
                    </Link>
                  ),
                },
                { key: 'kind', header: 'Kind', cell: (p) => humanize(p.kind) },
                {
                  key: 'title',
                  header: 'Title status',
                  cell: (p) => <StatusBadge status={p.titleStatus} />,
                },
                {
                  key: 'city',
                  header: 'City',
                  cell: (p) => p.address?.city ?? '—',
                  hideOnMobile: true,
                },
              ]}
            />
          </Section>

          <Section title={`Projects (${view.projects.length})`}>
            <DataTable
              caption="Projects"
              rows={view.projects}
              rowKey={(p) => p.id}
              rowLabel={(p) => p.name}
              emptyMessage="No projects."
              columns={[
                {
                  key: 'name',
                  header: 'Project',
                  cell: (p) => (
                    <Link href={`/admin/projects/${p.id}`} className="underline">
                      {p.name}
                    </Link>
                  ),
                },
                { key: 'kind', header: 'Kind', cell: (p) => humanize(p.kind) },
                { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
                {
                  key: 'updated',
                  header: 'Updated',
                  cell: (p) => formatDateTimeLabel(p.updatedAt),
                  hideOnMobile: true,
                },
              ]}
            />
          </Section>

          {view.permissions.finance ? (
            <Section
              title={`Invoices (${view.invoices.length})`}
              actions={
                <Link
                  href={`/admin/finance/invoices?organizationId=${org.id}`}
                  className="text-sm underline"
                >
                  Finance
                </Link>
              }
            >
              <DataTable
                caption="Invoices"
                rows={view.invoices}
                rowKey={(i) => i.id}
                rowLabel={(i) => i.number}
                emptyMessage="No invoices."
                columns={[
                  {
                    key: 'number',
                    header: 'Invoice',
                    cell: (i) => (
                      <Link href={`/admin/finance/invoices/${i.id}`} className="underline">
                        {i.number}
                      </Link>
                    ),
                  },
                  { key: 'kind', header: 'Kind', cell: (i) => humanize(i.kind) },
                  {
                    key: 'total',
                    header: 'Total',
                    cell: (i) => <Money kobo={i.totalKobo} currency={i.currency} />,
                  },
                  {
                    key: 'balance',
                    header: 'Balance',
                    cell: (i) => <Money kobo={i.balanceKobo} currency={i.currency} />,
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (i) => <StatusBadge status={i.status} />,
                  },
                ]}
              />
            </Section>
          ) : null}
        </div>

        <div className="space-y-6">
          <Section
            title="Support escalation"
            description="Opens a support-ticket conversation with the organisation's members; every message is recorded and visible to the customer unless marked internal."
          >
            <SupportEscalation
              organizationId={org.id}
              members={view.members.map((m) => ({ userId: m.userId, name: m.name, role: m.role }))}
              canManage={view.permissions.support || view.permissions.manage}
            />
            {view.conversations.length > 0 ? (
              <ul className="space-y-1">
                {view.conversations.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/admin/messages/${c.id}`} className="underline">
                      {c.subject}
                    </Link>
                    <span className="text-xs text-fg-muted">
                      {humanize(c.kind)} · {c.closedAt ? 'closed' : 'open'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
          <Section title="Impersonation">
            <GapNotice title="Not available">
              Support impersonation needs an endpoint that records the reason, expiry and audit
              entry and blocks financial approvals. None exists yet, so the control is hidden rather
              than shown disabled.
            </GapNotice>
          </Section>
        </div>
      </div>
    </div>
  );
}
