import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { PortfolioSection } from '@simplexd/contracts';
import { Alert, Badge, Button, PageHeader, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { adminContext } from '@/server/admin/context';
import {
  canExportSection,
  canSeeSection,
  exportNeedsMfa,
  portfolioAnalytics,
} from '@/server/admin/analytics/portfolio';
import { StatTile } from '../_components/bits';

export const metadata: Metadata = { title: 'Portfolio analytics' };
export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function PortfolioAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; organizationId?: string }>;
}) {
  const sp = await searchParams;
  const identity = await requireSignedIn('/admin/analytics');
  const ctx = adminContext(identity);
  const query = {
    from: sp.from && DATE.test(sp.from) ? sp.from : undefined,
    to: sp.to && DATE.test(sp.to) ? sp.to : undefined,
    organizationId: sp.organizationId?.trim() || undefined,
  };
  const loaded = await attempt(() => portfolioAnalytics(ctx, query));
  const orgs = await attempt(() => searchOrganizations(identity, undefined, 200));
  const mfa = identity.actor.mfaVerified;

  const exportHref = (section: PortfolioSection) => {
    const p = new URLSearchParams({ section });
    if (loaded.ok) {
      p.set('from', loaded.value.range.from);
      p.set('to', loaded.value.range.to);
    }
    if (query.organizationId) p.set('organizationId', query.organizationId);
    return `/api/v1/admin/analytics/portfolio/export?${p.toString()}`;
  };
  const exportLink = (section: PortfolioSection, label: string) => {
    if (!canSeeSection(ctx, section)) return null;
    if (canExportSection(ctx, section))
      return (
        <a
          key={section}
          href={exportHref(section)}
          className="text-sm text-primary underline"
          download
        >
          {label}
        </a>
      );
    return (
      <span key={section} className="text-xs text-fg-muted">
        {label}:{' '}
        {exportNeedsMfa(section)
          ? mfa
            ? 'needs finance.export'
            : 'needs finance.export with a verified authenticator'
          : 'not permitted'}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio analytics"
        description="Counts and sums derived from the records at the moment you load this page. Every export lists the rows a figure was summed from, so a spreadsheet total reproduces what you see here."
      />
      <form
        method="get"
        className="grid gap-3 rounded-lg border border-border bg-bg-elevated p-4 sm:grid-cols-[1fr_1fr_2fr_auto]"
      >
        <label className="text-sm">
          <span className="mb-1 block text-fg-muted">From</span>
          <input
            type="date"
            name="from"
            defaultValue={loaded.ok ? loaded.value.range.from : ''}
            className="h-11 w-full rounded-md border border-border-strong bg-bg px-3"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-fg-muted">To</span>
          <input
            type="date"
            name="to"
            defaultValue={loaded.ok ? loaded.value.range.to : ''}
            className="h-11 w-full rounded-md border border-border-strong bg-bg px-3"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-fg-muted">Customer organisation</span>
          {orgs.ok ? (
            <select
              name="organizationId"
              defaultValue={query.organizationId ?? ''}
              className="h-11 w-full rounded-md border border-border-strong bg-bg px-3"
            >
              <option value="">All organisations</option>
              {orgs.value.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="organizationId"
              defaultValue={query.organizationId ?? ''}
              placeholder="Organisation id"
              className="h-11 w-full rounded-md border border-border-strong bg-bg px-3"
            />
          )}
        </label>
        <div className="flex items-end">
          <Button type="submit">Apply</Button>
        </div>
      </form>

      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="Portfolio analytics" />
      ) : (
        <AnalyticsSections data={loaded.value} exportLink={exportLink} />
      )}
    </div>
  );
}

type Dto = Awaited<ReturnType<typeof portfolioAnalytics>>;

function AnalyticsSections({
  data,
  exportLink,
}: {
  data: Dto;
  exportLink: (section: PortfolioSection, label: string) => ReactNode;
}) {
  const r = data.range;
  const nothing =
    !data.properties && !data.arrears && !data.projects && !data.serviceRequests && !data.revenue;
  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-muted">
        Range {formatDateLabel(r.from)} to {formatDateLabel(r.to)} (Africa/Lagos). Point-in-time
        sections are as at {formatDateLabel(r.asOf)}.
        {data.organizationId ? ` Limited to organisation ${data.organizationId}.` : ''}
      </p>
      {nothing ? (
        <Alert tone="info" title="No section is available to your role">
          Analytics sections need finance.read, rentals.manage, projects.read_all or
          service_requests.read_all.
        </Alert>
      ) : null}

      {data.properties ? (
        <Section
          title="Properties and occupancy"
          description={`As at ${formatDateLabel(r.asOf)}: properties not archived, their units, and units with a lease active on that date.`}
          actions={[
            exportLink('properties', 'Export properties CSV'),
            exportLink('occupancy', 'Export units CSV'),
          ]}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Properties"
              value={data.properties.propertyCount}
              href="/admin/properties"
            />
            <StatTile label="Units" value={data.properties.unitCount} />
            <StatTile
              label="Occupied units"
              value={data.properties.occupiedUnits}
              hint={
                data.properties.occupancyPct === null
                  ? 'No units recorded'
                  : `${data.properties.occupancyPct}% occupancy`
              }
            />
            <StatTile
              label="Active leases"
              value={data.properties.activeLeases}
              hint={`${data.properties.wholePropertyLeases} whole-property`}
              href="/admin/rentals"
            />
          </div>
        </Section>
      ) : null}

      {data.arrears ? (
        <Section
          title="Rent arrears"
          description={`Rent and service-charge invoices issued on or before ${formatDateLabel(data.arrears.asOf)} minus allocations to that date; overdue means past the due date.`}
          actions={exportLink('arrears', 'Export invoices CSV')}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Outstanding"
              value={<Money kobo={data.arrears.outstandingKobo} />}
              hint={`${data.arrears.invoiceCount} invoices with a balance`}
            />
            <StatTile
              label="Overdue"
              value={<Money kobo={data.arrears.overdueKobo} />}
              tone={data.arrears.overdueKobo !== '0' ? 'warning' : 'neutral'}
            />
            <StatTile
              label="Not yet due"
              value={<Money kobo={data.arrears.buckets.current ?? '0'} />}
            />
          </div>
          <table className="mt-3 w-full text-sm">
            <caption className="sr-only">Arrears ageing</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="py-1 font-medium">Bucket</th>
                <th className="py-1 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.arrears.buckets).map(([b, v]) => (
                <tr key={b} className="border-t border-border">
                  <td className="py-1">{humanize(b)}</td>
                  <td className="py-1 text-right">
                    <Money kobo={v} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {data.projects ? (
        <Section
          title="Active projects"
          description={`Current position${data.projects.scope === 'assigned' ? ' of the projects you manage' : ''}; approved budget includes contingency, forecast is the commitment-based method used on each project.`}
          actions={exportLink('projects', 'Export projects CSV')}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Active projects"
              value={data.projects.activeCount}
              hint={`${data.projects.withApprovedBudget} with an approved budget`}
              href="/admin/projects"
            />
            <StatTile
              label="Approved budget"
              value={<Money kobo={data.projects.approvedBudgetKobo} />}
            />
            <StatTile
              label="Forecast final cost"
              value={<Money kobo={data.projects.forecastFinalCostKobo} />}
              hint={
                <>
                  Variance <Money kobo={data.projects.varianceKobo} />
                </>
              }
              tone={data.projects.overBudgetCount > 0 ? 'warning' : 'neutral'}
            />
            <StatTile
              label="Committed / actual"
              value={<Money kobo={data.projects.committedKobo} />}
              hint={<Money kobo={data.projects.actualKobo} />}
            />
          </div>
          {data.projects.overBudgetCount > 0 ? (
            <p className="text-sm text-warning">
              {data.projects.overBudgetCount} project(s) are over-committed or over-spent.
            </p>
          ) : null}
        </Section>
      ) : null}

      {data.changeOrders ? (
        <Section
          title="Open change orders"
          description="Exposure is the sum of change orders submitted and awaiting a decision; drafts are counted but not added."
          actions={exportLink('change_orders', 'Export change orders CSV')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile label="Awaiting decision" value={data.changeOrders.openCount} />
            <StatTile
              label="Exposure if all approved"
              value={<Money kobo={data.changeOrders.openExposureKobo} />}
            />
          </div>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {Object.entries(data.changeOrders.byStatus).map(([s, v]) => (
              <li key={s}>
                <Badge tone="neutral">
                  {humanize(s)}: {v.count} · <Money kobo={v.deltaKobo} />
                </Badge>
              </li>
            ))}
            {Object.keys(data.changeOrders.byStatus).length === 0 ? (
              <li className="text-fg-muted">None open.</li>
            ) : null}
          </ul>
        </Section>
      ) : null}

      {data.serviceRequests ? (
        <Section
          title="Service requests"
          description={`Requests created in the range${data.serviceRequests.scope === 'assigned' ? ' that you manage' : ''}, by status and service. SLA figures are for those still open now.`}
          actions={exportLink('service_requests', 'Export requests CSV')}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Created in range"
              value={data.serviceRequests.createdInRange}
              href="/admin/service-requests"
            />
            <StatTile
              label="Open with an SLA due time"
              value={data.serviceRequests.sla.openWithDueTime}
            />
            <StatTile
              label="Past SLA now"
              value={data.serviceRequests.sla.openBreaches}
              tone={data.serviceRequests.sla.openBreaches > 0 ? 'danger' : 'neutral'}
            />
            <StatTile
              label="Due within 8 hours"
              value={data.serviceRequests.sla.dueSoon}
              tone={data.serviceRequests.sla.dueSoon > 0 ? 'warning' : 'neutral'}
            />
          </div>
          {data.serviceRequests.sla.activePolicies === 0 ? (
            <Alert tone="info" title="No SLA policies are configured">
              Due times exist only where a triager typed one.{' '}
              <Link href="/admin/services/sla-policies" className="underline">
                Configure SLA policies
              </Link>
              .
            </Alert>
          ) : (
            <p className="text-xs text-fg-muted">
              {data.serviceRequests.sla.activePolicies} active SLA policies.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <table className="w-full text-sm">
              <caption className="text-left text-xs font-medium uppercase tracking-wide text-fg-muted">
                By status
              </caption>
              <tbody>
                {Object.entries(data.serviceRequests.byStatus).map(([s, n]) => (
                  <tr key={s} className="border-t border-border">
                    <td className="py-1">{humanize(s)}</td>
                    <td className="py-1 text-right">{n}</td>
                  </tr>
                ))}
                {Object.keys(data.serviceRequests.byStatus).length === 0 ? (
                  <tr>
                    <td className="py-1 text-fg-muted">No requests in this range.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <table className="w-full text-sm">
              <caption className="text-left text-xs font-medium uppercase tracking-wide text-fg-muted">
                By service
              </caption>
              <tbody>
                {data.serviceRequests.byService.map((s) => (
                  <tr key={s.serviceId} className="border-t border-border">
                    <td className="py-1">{s.serviceName}</td>
                    <td className="py-1 text-right">
                      {s.total} <span className="text-xs text-fg-muted">({s.open} open)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {data.revenue ? (
        <Section
          title="Revenue by month"
          description="Net credits to revenue accounts in journals posted in the range (Africa/Lagos months). Rent collected for owners is a liability, not revenue, so it never appears here."
          actions={exportLink('revenue', 'Export journal lines CSV')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile
              label="Revenue in range"
              value={<Money kobo={data.revenue.totalKobo} />}
              hint={`${data.revenue.lineCount} journal lines`}
              href="/admin/finance/journals"
            />
            <StatTile label="Revenue accounts touched" value={data.revenue.byAccount.length} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <table className="w-full text-sm">
              <caption className="text-left text-xs font-medium uppercase tracking-wide text-fg-muted">
                Months
              </caption>
              <tbody>
                {data.revenue.months.map((m) => (
                  <tr key={m.month} className="border-t border-border">
                    <td className="py-1 font-mono">{m.month}</td>
                    <td className="py-1 text-right">
                      <Money kobo={m.revenueKobo} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full text-sm">
              <caption className="text-left text-xs font-medium uppercase tracking-wide text-fg-muted">
                Accounts
              </caption>
              <tbody>
                {data.revenue.byAccount.map((a) => (
                  <tr key={a.code} className="border-t border-border">
                    <td className="py-1">
                      <span className="font-mono">{a.code}</span> {a.name}
                    </td>
                    <td className="py-1 text-right">
                      <Money kobo={a.revenueKobo} />
                    </td>
                  </tr>
                ))}
                {data.revenue.byAccount.length === 0 ? (
                  <tr>
                    <td className="py-1 text-fg-muted">No revenue journals in this range.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
      <p className="text-xs text-fg-muted">
        Generated {data.generatedAt}. How exports reconcile: docs/workflows/admin-configuration.md.
      </p>
    </div>
  );
}
