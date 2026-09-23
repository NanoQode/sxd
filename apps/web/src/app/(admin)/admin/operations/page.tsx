import type { Metadata } from 'next';
import Link from 'next/link';
import { adminJobListQuerySchema, type JobStatus } from '@simplexd/contracts';
import { Alert, PageHeader, buttonVariants } from '@simplexd/ui';
import { LoadError } from '@/components/admin/load-error';
import { Section, TabLink, TabNav } from '@/components/admin/section';
import { attempt, can } from '@/lib/admin/server/context';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import {
  listJobs,
  listStuckOutbox,
  operationsAccess,
  queueSummary,
  type OperationsAccess,
} from '@/server/admin/operations/jobs';
import { StatTile } from '../_components/bits';
import { JobsTable, StuckOutboxTable } from './operations-tables';

export const metadata: Metadata = { title: 'Jobs and outbox' };
export const dynamic = 'force-dynamic';

const PATH = '/admin/operations';
const STATUS_TABS: Array<{ status: JobStatus; label: string }> = [
  { status: 'dead', label: 'Dead' },
  { status: 'failed', label: 'Failed' },
  { status: 'pending', label: 'Pending' },
  { status: 'running', label: 'Running' },
];

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

function fmtAge(seconds: number | null): string {
  if (seconds === null) return 'None waiting';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** Why retry/requeue controls are absent; never shows dead buttons. */
function ReadOnlyNotice({ access }: { access: OperationsAccess }) {
  if (access.canManage) return null;
  if (access.manageDeniedCode === 'mfa_required') {
    return (
      <Alert tone="warning" title="Read-only: verify your authenticator to retry">
        Retrying dead jobs and requeueing outbox events are protected by multi-factor
        authentication. You can review everything below.{' '}
        <Link href="/admin/security/mfa" className="font-medium underline">
          Set up or verify your authenticator
        </Link>
        , then reload this page.
      </Alert>
    );
  }
  if (access.manageDeniedCode === 'impersonation_forbidden') {
    return (
      <Alert tone="info" title="Read-only while impersonating">
        Retry and requeue are not available during an impersonation session.
      </Alert>
    );
  }
  return (
    <Alert tone="info" title="Read-only view">
      Retrying jobs and requeueing outbox events need the platform settings permission (super admin)
      and a verified authenticator.{' '}
      <Link href="/admin/security/mfa" className="font-medium underline">
        Authenticator settings
      </Link>
      .
    </Alert>
  );
}

/**
 * Operations: dead-letter review and retry for the job queue, and outbox
 * events the relay stopped claiming. Reads need audit.read or
 * platform.settings.manage; the actions are MFA-gated and audited. Nothing
 * MFA-gated runs during render for viewers who cannot use it.
 */
export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireSignedIn(PATH);
  const ctx = adminContext(identity);
  const access = operationsAccess(ctx);
  const sp = await searchParams;
  const parsed = adminJobListQuerySchema.safeParse({
    status: first(sp['status']) ?? 'dead',
    cursor: first(sp['cursor']),
    limit: 25,
  });
  const query: { status: JobStatus; cursor?: string; limit: number } = parsed.success
    ? { ...parsed.data, status: parsed.data.status ?? 'dead' }
    : { status: 'dead', limit: 25 };

  const header = (
    <PageHeader
      title="Jobs and outbox"
      description="Background jobs that exhausted their retries, and outbox events the relay stopped routing. Payloads are never shown; retries are recorded in the audit log."
    />
  );

  const loaded = await attempt(() =>
    Promise.all([queueSummary(ctx), listJobs(ctx, query), listStuckOutbox(ctx, 50)]),
  );
  if (!loaded.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError code={loaded.code} message={loaded.message} what="Jobs and outbox" />
      </div>
    );
  }
  const [summary, jobs, stuck] = loaded.value;
  const status = query.status;
  const auditLink = can(identity, 'audit.read');

  return (
    <div className="space-y-6">
      {header}
      <ReadOnlyNotice access={access} />

      <section aria-labelledby="ops-summary" className="space-y-3">
        <h2 id="ops-summary" className="sr-only">
          Queue summary
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile
            label="Dead jobs"
            value={summary.dead}
            href={`${PATH}?status=dead`}
            tone={summary.dead > 0 ? 'danger' : 'neutral'}
            hint="Exhausted retries"
          />
          <StatTile label="Pending jobs" value={summary.pending} href={`${PATH}?status=pending`} />
          <StatTile label="Running jobs" value={summary.running} href={`${PATH}?status=running`} />
          <StatTile
            label="Oldest due job waiting"
            value={fmtAge(summary.oldestPendingSeconds)}
            tone={(summary.oldestPendingSeconds ?? 0) > 300 ? 'warning' : 'neutral'}
            hint="Alert threshold 5 min"
          />
          <StatTile
            label="Unpublished outbox events"
            value={summary.outboxUnpublished}
            hint="Relayed by the worker"
          />
          <StatTile
            label="Stuck outbox events"
            value={summary.outboxStuck}
            href="#stuck-outbox"
            tone={summary.outboxStuck > 0 ? 'warning' : 'neutral'}
            hint={`${summary.outboxStuckThreshold}+ failed attempts`}
          />
        </div>
      </section>

      <Section
        title="Jobs"
        description={
          <>
            Dead jobs used every attempt and wait here until someone retries them.{' '}
            {auditLink ? (
              <Link href="/admin/audit?entityType=job" className="underline">
                Past retries in the audit log
              </Link>
            ) : null}
          </>
        }
      >
        <TabNav label="Job status">
          {STATUS_TABS.map((tab) => (
            <TabLink
              key={tab.status}
              href={`${PATH}?status=${tab.status}`}
              active={tab.status === status}
            >
              {tab.label}
            </TabLink>
          ))}
        </TabNav>
        <JobsTable items={jobs.items} status={status} canManage={access.canManage} />
        {query.cursor || jobs.nextCursor ? (
          <nav aria-label="Jobs pages" className="flex flex-wrap justify-between gap-2">
            {query.cursor ? (
              <Link
                href={`${PATH}?status=${status}`}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                First page
              </Link>
            ) : (
              <span />
            )}
            {jobs.nextCursor ? (
              <Link
                href={`${PATH}?status=${status}&cursor=${encodeURIComponent(jobs.nextCursor)}`}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </Section>

      <Section
        id="stuck-outbox"
        title="Stuck outbox events"
        description={`Unpublished events that failed routing ${stuck.threshold} times. The relay skips them until they are requeued.${stuck.total > stuck.items.length ? ` Showing the oldest ${stuck.items.length} of ${stuck.total}.` : ''}`}
      >
        <StuckOutboxTable
          items={stuck.items}
          canManage={access.canManage}
          threshold={stuck.threshold}
        />
      </Section>
    </div>
  );
}
