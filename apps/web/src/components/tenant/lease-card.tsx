import { MapPin } from 'lucide-react';
import Link from 'next/link';
import type { TenantLeaseSummary } from '@simplexd/contracts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@simplexd/ui';
import {
  LEASE_KIND_LABELS,
  LEASE_STATUS_COPY,
  RENT_PERIOD_LABELS,
  formatAddress,
  formatDay,
  formatMoney,
  leaseTitle,
} from '@/lib/tenant/model';
import { LeaseStatusBadge } from './status';

/** Summary of one of the caller's leases: where, what it costs, when it runs. */
export function LeaseCard({
  summary,
  heading = 'Your lease',
  showLink = true,
}: {
  summary: TenantLeaseSummary;
  heading?: string;
  showLink?: boolean;
}) {
  const { lease } = summary;
  const address = formatAddress(summary.property.address);
  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">{heading}</p>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          {leaseTitle(summary)}
          <LeaseStatusBadge status={lease.status} />
        </CardTitle>
        {address ? (
          <CardDescription className="flex items-start gap-1">
            <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {address}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-fg-muted">Rent</dt>
            <dd className="font-medium">
              {formatMoney(lease.rentAmountKobo, lease.currency)}{' '}
              {RENT_PERIOD_LABELS[lease.rentPeriod] ?? lease.rentPeriod}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Term</dt>
            <dd>
              {formatDay(lease.startDate)} –{' '}
              {lease.endDate ? formatDay(lease.endDate) : 'open-ended'}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Type</dt>
            <dd>{LEASE_KIND_LABELS[lease.kind] ?? lease.kind}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Status</dt>
            <dd>{LEASE_STATUS_COPY[lease.status]}</dd>
          </div>
        </dl>
        {showLink ? (
          <Link
            href={`/tenant/lease/${lease.id}`}
            className="sx-touch inline-flex items-center text-sm font-medium text-primary underline"
          >
            View lease terms and rent schedule
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
