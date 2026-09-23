import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { overviewCounts } from '@/server/admin/overview';
import { StatTile } from './_components/bits';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

const MARKET_STATES = ['draft', 'in_review', 'published', 'unpublished', 'archived'] as const;
const LEAD_STATES = ['new', 'contacted', 'qualified', 'converted', 'closed_lost', 'spam'] as const;

/** Live counts from the database; sections the actor cannot access are simply not shown. */
export default async function AdminOverviewPage() {
  const identity = await requireSignedIn('/admin');
  const counts = await overviewCounts(adminContext(identity));
  const marketTotal = counts.markets ? Object.values(counts.markets).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="space-y-8">
      <PageHeader
        title={`Welcome, ${identity.session?.user.name ?? 'there'}`}
        description="Live counts from the records you are allowed to see. Every number links to the underlying list."
      />

      {counts.markets ? (
        <section aria-labelledby="ov-markets" className="space-y-3">
          <h2 id="ov-markets" className="text-lg font-semibold">
            Market data
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Markets" value={marketTotal} href="/admin/market-data" />
            {MARKET_STATES.map((s) => (
              <StatTile
                key={s}
                label={s.replace(/_/g, ' ')}
                value={counts.markets?.[s] ?? 0}
                href={`/admin/market-data?publicationState=${s}`}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile
              label="Observations pending review"
              value={counts.pendingInterpretations ?? 0}
              href="/admin/market-data/observations?pendingOnly=true"
              tone={(counts.pendingInterpretations ?? 0) > 0 ? 'warning' : 'neutral'}
            />
            <StatTile
              label="Open research tasks"
              value={counts.openResearchTasks ?? 0}
              href="/admin/market-data?pendingReview=false"
              hint="Across all markets"
            />
            <StatTile
              label="Rank-eligible published evidence"
              value={counts.rankEligibleEvidence ?? 0}
              href="/admin/market-data/observations?rankEligible=true&publicationState=published"
              hint={
                (counts.rankEligibleEvidence ?? 0) === 0
                  ? 'No evidence qualifies for ranking yet'
                  : undefined
              }
              tone={(counts.rankEligibleEvidence ?? 0) === 0 ? 'warning' : 'success'}
            />
            <StatTile
              label="Active ranking policy"
              value={counts.activePolicyVersion ? `v${counts.activePolicyVersion}` : 'none'}
              href="/admin/market-data/ranking-policies"
              tone={counts.activePolicyVersion ? 'neutral' : 'danger'}
            />
          </div>
        </section>
      ) : null}

      {counts.leads ? (
        <section aria-labelledby="ov-leads" className="space-y-3">
          <h2 id="ov-leads" className="text-lg font-semibold">
            Leads
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {LEAD_STATES.map((s) => (
              <StatTile
                key={s}
                label={s.replace(/_/g, ' ')}
                value={counts.leads?.[s] ?? 0}
                href={`/admin/leads?status=${s}`}
                tone={s === 'new' && (counts.leads?.[s] ?? 0) > 0 ? 'warning' : 'neutral'}
              />
            ))}
          </div>
        </section>
      ) : null}

      {counts.deadJobs !== null || counts.staffCount !== null || counts.pendingPartners !== null ? (
        <section aria-labelledby="ov-ops" className="space-y-3">
          <h2 id="ov-ops" className="text-lg font-semibold">
            Operations and access
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {counts.deadJobs !== null ? (
              <StatTile
                label="Dead jobs"
                value={counts.deadJobs}
                href="/admin/audit?entityType=job"
                tone={counts.deadJobs > 0 ? 'danger' : 'neutral'}
                hint="Exhausted retries; retry from the worker admin in wave 3"
              />
            ) : null}
            {counts.unpublishedOutbox !== null ? (
              <StatTile
                label="Unpublished outbox events"
                value={counts.unpublishedOutbox}
                href="/admin/audit"
                tone={counts.unpublishedOutbox > 50 ? 'warning' : 'neutral'}
                hint="Relayed by the worker"
              />
            ) : null}
            {counts.staffCount !== null ? (
              <StatTile label="Staff members" value={counts.staffCount} href="/admin/access" />
            ) : null}
            {counts.pendingPartners !== null ? (
              <StatTile
                label="Partners awaiting verification"
                value={counts.pendingPartners}
                href="/admin/access/partners"
                tone={counts.pendingPartners > 0 ? 'warning' : 'neutral'}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {!identity.actor.mfaVerified ? (
        <Alert tone="warning" title="Enrol an authenticator to unlock sensitive actions">
          Publishing, policy changes, role management and settings require MFA.{' '}
          <Link href="/admin/security/mfa" className="font-medium text-primary underline">
            Set it up now
          </Link>
          .
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Build status</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-fg-muted">
          Sections marked with a wave badge in the navigation are scheduled for a later release.{' '}
          <Link href="/admin/implementation-status" className="text-primary underline">
            Read the implementation status
          </Link>{' '}
          for the requirement-by-requirement account.
        </CardContent>
      </Card>
    </div>
  );
}
