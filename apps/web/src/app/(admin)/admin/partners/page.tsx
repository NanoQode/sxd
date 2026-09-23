import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, DataTable, PageHeader, StatusBadge, buttonVariants, formatDateLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { listPartners } from '@/lib/admin/server/partners';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { StatTile } from '../_components/bits';

export const metadata: Metadata = { title: 'Partners' };
export const dynamic = 'force-dynamic';

const PARTNER_TYPES = ['contractor', 'inspector', 'surveyor', 'legal', 'architect', 'quantity_surveyor', 'valuer', 'vendor', 'agent', 'other'];
const VERIFICATION = ['unverified', 'pending', 'verified', 'expired', 'rejected'];

export default async function PartnersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireSignedIn('/admin/partners');
  const raw = await searchParams;
  const loaded = await attempt(() =>
    listPartners(identity, {
      verificationStatus: VERIFICATION.includes(raw.status ?? '') ? raw.status : undefined,
      partnerType: PARTNER_TYPES.includes(raw.type ?? '') ? raw.type : undefined,
      q: raw.q?.trim() || undefined,
    }),
  );
  if (!loaded.ok) return <LoadError code={loaded.code} message={loaded.message} what="The partner directory" />;
  const rows = loaded.value;
  const canVerify = can(identity, 'access.partners.verify');
  const now = Date.now();
  const expiringSoon = rows.filter((r) => r.verificationExpiresAt && new Date(r.verificationExpiresAt).getTime() - now < 30 * 86_400_000).length;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Partners"
        description="Contractors, inspectors, surveyors, legal and other professional partners: what was verified and until when, coverage, disclosed conflicts, and how much work they carry. A verification badge states only what was checked."
        actions={
          canVerify ? (
            <Link href="/admin/access/partners" className={buttonVariants({ size: 'md' })}>
              Verification queue
            </Link>
          ) : undefined
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Partners" value={rows.length} />
        <StatTile label="Verified" value={rows.filter((r) => r.verificationStatus === 'verified').length} tone="success" href="/admin/partners?status=verified" />
        <StatTile label="Awaiting verification" value={rows.filter((r) => r.verificationStatus === 'pending').length} tone="warning" href={canVerify ? '/admin/access/partners' : '/admin/partners?status=pending'} />
        <StatTile label="Verification expiring ≤ 30 days" value={expiringSoon} tone={expiringSoon > 0 ? 'warning' : 'neutral'} />
      </div>
      <SavedViewsBar tableKey="partners" />
      <FilterBar>
        <FilterSelect name="type" label="Type" value={raw.type} options={PARTNER_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
        <FilterSelect name="status" label="Verification" value={raw.status} options={VERIFICATION.map((t) => ({ value: t, label: humanize(t) }))} />
        <FilterInput name="q" label="Search" value={raw.q} placeholder="Name, email or trading name" />
      </FilterBar>
      <div className="flex justify-end">
        <ExportCsvButton
          rows={rows}
          filename="partners.csv"
          columns={[
            { header: 'Name', value: (r) => r.name },
            { header: 'Trading name', value: (r) => r.displayName },
            { header: 'Type', value: (r) => r.partnerType },
            { header: 'Verification', value: (r) => r.verificationStatus },
            { header: 'Verified at', value: (r) => r.verifiedAt },
            { header: 'Expires', value: (r) => r.verificationExpiresAt },
            { header: 'Active assignments', value: (r) => r.assignments.active },
            { header: 'Completed assignments', value: (r) => r.assignments.completed },
            { header: 'Declined', value: (r) => r.assignments.declined },
            { header: 'Revoked', value: (r) => r.assignments.revoked },
            { header: 'Tender invitations', value: (r) => r.tenderInvitations },
            { header: 'Bids submitted', value: (r) => r.bids.submitted },
            { header: 'Awards', value: (r) => r.bids.awarded },
          ]}
        />
      </div>
      <DataTable
        caption="Partner directory"
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        emptyMessage="No partners match."
        columns={[
          {
            key: 'name',
            header: 'Partner',
            cell: (r) => (
              <span>
                <span className="font-medium">{r.displayName ?? r.name}</span>
                <span className="block text-xs text-fg-muted">
                  {r.name} · {r.email}
                </span>
              </span>
            ),
          },
          { key: 'type', header: 'Type', cell: (r) => humanize(r.partnerType) },
          {
            key: 'ver',
            header: 'Verification',
            cell: (r) => (
              <span>
                <StatusBadge status={r.verificationStatus === 'verified' ? 'verified' : r.verificationStatus === 'pending' ? 'pending' : r.verificationStatus === 'rejected' ? 'rejected' : r.verificationStatus === 'expired' ? 'expired' : 'draft'} label={humanize(r.verificationStatus)} />
                <span className="block text-xs text-fg-muted">
                  {r.verifiedAt ? `checked ${formatDateLabel(r.verifiedAt)}` : 'no check recorded'}
                  {r.verificationExpiresAt ? ` · until ${formatDateLabel(r.verificationExpiresAt)}` : ''}
                  {` · ${r.credentialCount} credential${r.credentialCount === 1 ? '' : 's'}`}
                </span>
              </span>
            ),
          },
          { key: 'cov', header: 'Coverage / availability', cell: (r) => `${r.coverageStateCount} state${r.coverageStateCount === 1 ? '' : 's'} · ${humanize(r.availabilityStatus)}`, hideOnMobile: true },
          { key: 'conf', header: 'Conflicts', cell: (r) => (r.conflictDisclosure ? <span title={r.conflictDisclosure}><Badge tone="warning">disclosed</Badge></span> : <span className="text-xs text-fg-muted">none recorded</span>), hideOnMobile: true },
          {
            key: 'work',
            header: 'Assignments',
            cell: (r) => (
              <Link href={`/admin/assignments?view=list&assignee=${encodeURIComponent(r.userId)}`} className="underline">
                {r.assignments.active} active · {r.assignments.completed} done
              </Link>
            ),
          },
          { key: 'perf', header: 'Declined / revoked', cell: (r) => `${r.assignments.declined} / ${r.assignments.revoked}`, hideOnMobile: true },
          { key: 'tenders', header: 'Tenders', cell: (r) => `${r.tenderInvitations} invited · ${r.bids.submitted} bids · ${r.bids.awarded} won` },
          { key: 'rating', header: 'Rating', cell: (r) => r.ratingAverage ?? <span className="text-fg-subtle">none</span>, hideOnMobile: true },
        ]}
      />
    </div>
  );
}
