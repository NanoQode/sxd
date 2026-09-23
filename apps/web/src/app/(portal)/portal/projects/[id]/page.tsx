import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn, type RequestIdentity } from '@/lib/auth/session';
import { koboToNaira } from '@/lib/portal/format';
import { capabilityNote, customerCapabilities, type CustomerCapabilities } from '@/lib/portal/server/permissions';
import { buildProjectTimeline } from '@/lib/portal/server/projects';
import { BudgetDecision, ChangeOrderDecision, MilestoneDecision } from '@/components/portal/decisions';
import { EvidenceGallery } from '@/components/portal/evidence-gallery';
import { NotesPanel } from '@/components/portal/notes-panel';
import { SectionTabs, resolveTab } from '@/components/portal/section-tabs';
import { Timeline } from '@/components/portal/timeline';
import { listNotes } from '@/server/notes/service';
import { getBudgetVariance, listBudgetVersions, listCommitments } from '@/server/projects/budgets';
import { listChangeOrders } from '@/server/projects/change-orders';
import { listDefects } from '@/server/projects/defects';
import { listEvidence } from '@/server/projects/evidence';
import { listMilestones } from '@/server/projects/milestones';
import { getProjectOverview } from '@/server/projects/projects';
import { listReports } from '@/server/projects/reports';
import { getSchedule } from '@/server/projects/schedule';
import { listSiteVisits } from '@/server/projects/site-visits';

export const metadata: Metadata = { title: 'Project' };
export const dynamic = 'force-dynamic';

const TABS = ['overview', 'schedule', 'budget', 'reports', 'media', 'defects', 'decisions', 'timeline'] as const;

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/projects/${id}`);
  const overview = await getProjectOverview(identity, id).catch((err) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) return null;
    throw err;
  });
  if (!overview) notFound();
  const tab = resolveTab(tabParam, TABS);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity, overview.project.organizationId);
  const project = overview.project;
  const basePath = `/portal/projects/${id}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/projects" className="underline">
            Projects
          </Link>
        }
        title={project.name}
        description={`${humanize(project.kind)}${project.description ? ` · ${project.description}` : ''}`}
        actions={<StatusBadge status={project.status} />}
      />
      <SectionTabs
        basePath={basePath}
        active={tab}
        label="Project sections"
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'schedule', label: 'Schedule' },
          { value: 'budget', label: 'Budget' },
          { value: 'reports', label: 'Reports' },
          { value: 'media', label: 'Media' },
          { value: 'defects', label: 'Defects', badge: overview.defects.open > 0 ? <Badge tone="warning">{overview.defects.open}</Badge> : undefined },
          { value: 'decisions', label: 'Decisions', badge: overview.pendingApprovals > 0 ? <Badge tone="warning">{overview.pendingApprovals}</Badge> : undefined },
          { value: 'timeline', label: 'Timeline' },
        ]}
      />
      {tab === 'overview' ? <OverviewTab overview={overview} zone={zone} identity={identity} /> : null}
      {tab === 'schedule' ? <ScheduleTab identity={identity} projectId={id} /> : null}
      {tab === 'budget' ? <BudgetTab identity={identity} projectId={id} caps={caps} zone={zone} /> : null}
      {tab === 'reports' ? <ReportsTab identity={identity} projectId={id} zone={zone} /> : null}
      {tab === 'media' ? <MediaTab identity={identity} projectId={id} zone={zone} /> : null}
      {tab === 'defects' ? <DefectsTab identity={identity} projectId={id} zone={zone} /> : null}
      {tab === 'decisions' ? <DecisionsTab identity={identity} projectId={id} caps={caps} zone={zone} /> : null}
      {tab === 'timeline' ? <TimelineTab identity={identity} overview={overview} zone={zone} /> : null}
    </div>
  );
}

type Overview = NonNullable<Awaited<ReturnType<typeof getProjectOverview>>>;

async function OverviewTab({ overview, zone, identity }: { overview: Overview; zone: string; identity: RequestIdentity }) {
  const v = overview.budget.variance;
  const notes = await listNotes(identity, { entityType: 'project', entityId: overview.project.id, limit: 50 });
  const statusCopy: Record<string, string> = {
    no_approved_budget: 'No approved budget yet; commitments are tracked but not measured against a baseline.',
    within_budget: 'Commitments and actuals sit within the approved budget.',
    over_committed: 'Commitments exceed the approved budget; a change order is expected.',
    over_spent: 'Actual spend exceeds the approved budget.',
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-fg-muted">Approved budget</CardTitle>
              <p className="font-display text-2xl font-semibold">{v.hasApprovedBudget ? koboToNaira(v.approvedTotalKobo) : 'Not approved'}</p>
              <CardDescription>
                {overview.budget.approvedVersion ? `Version ${overview.budget.approvedVersion}, approved ${overview.budget.approvedAt ? formatDateLabel(overview.budget.approvedAt, zone) : ''}` : statusCopy[v.status]}
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-fg-muted">Committed / actual</CardTitle>
              <p className="font-display text-2xl font-semibold">{koboToNaira(v.committedKobo)}</p>
              <CardDescription>
                Actual spend {koboToNaira(v.actualKobo)} · exposure {koboToNaira(v.exposureKobo)}
                {v.pendingChangeOrderDeltaKobo !== '0' ? ` · pending change orders ${koboToNaira(v.pendingChangeOrderDeltaKobo)}` : ''}
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-fg-muted">Variance / forecast</CardTitle>
              <p className="font-display text-2xl font-semibold">{v.varianceKobo !== null ? koboToNaira(v.varianceKobo) : '—'}</p>
              <CardDescription>
                {v.forecastFinalCostKobo !== null ? `Forecast final cost ${koboToNaira(v.forecastFinalCostKobo)} (commitment based)` : statusCopy[v.status]}
                {v.variancePct !== null ? ` · ${v.variancePct.toFixed(1)}%` : ''}
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-fg-muted">Completion</CardTitle>
              <p className="font-display text-2xl font-semibold">{overview.schedule.forecastCompletionDate ?? overview.schedule.targetCompletionDate ?? 'Unknown'}</p>
              <CardDescription>
                {overview.schedule.forecastCompletionDate
                  ? `Forecast from ${humanize(overview.schedule.forecastSource)}; target ${overview.schedule.targetCompletionDate ?? 'not set'}`
                  : 'No forecast: the schedule is missing inputs or no baseline exists yet.'}
                {overview.schedule.percentComplete !== null ? ` · ${overview.schedule.percentComplete}% complete` : ''}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
        {v.notes.length > 0 ? (
          <Alert tone="info" title="How these figures are computed">
            <ul className="list-disc pl-5">
              {v.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Milestones</CardTitle>
            <CardDescription>
              {overview.milestones.total === 0
                ? 'No milestones defined yet.'
                : `${overview.milestones.total} milestones · ${Object.entries(overview.milestones.byStatus)
                    .filter(([, n]) => n > 0)
                    .map(([s, n]) => `${n} ${humanize(s).toLowerCase()}`)
                    .join(', ')}${overview.milestones.nextPlannedDate ? ` · next planned ${overview.milestones.nextPlannedDate}` : ''}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3 text-sm">
            <Link href={`/portal/projects/${overview.project.id}?tab=decisions`} className="text-primary underline">
              Milestones awaiting acceptance
            </Link>
            <Link href={`/portal/projects/${overview.project.id}?tab=schedule`} className="text-primary underline">
              Full schedule
            </Link>
            {overview.latestReleasedReport ? (
              <Link href={`/portal/reports/${overview.latestReleasedReport.id}`} className="text-primary underline">
                Latest report: {overview.latestReleasedReport.title}
              </Link>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
            <CardDescription>Shared with the project team; staff-only notes are never shown.</CardDescription>
          </CardHeader>
          <CardContent>
            <NotesPanel entityType="project" entityId={overview.project.id} notes={notes.items} zone={zone} readOnly={overview.project.status === 'archived' || overview.project.status === 'cancelled'} readOnlyReason="This project is closed; notes are read-only." />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.team.length === 0 ? (
              <p className="text-sm text-fg-muted">No one is assigned yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {overview.team.map((m) => (
                  <li key={`${m.userId}-${m.role}`} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{m.name ?? 'Team member'}</span>
                    <span className="text-fg-muted">
                      {humanize(m.role)} · {humanize(m.status)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>At a glance</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-muted">Open defects</dt>
              <dd>{overview.defects.open}</dd>
              <dt className="text-fg-muted">Pending change orders</dt>
              <dd>{overview.changeOrders.pending}</dd>
              <dt className="text-fg-muted">Approved change orders</dt>
              <dd>{overview.changeOrders.approved}</dd>
              <dt className="text-fg-muted">Awaiting your approval</dt>
              <dd>{overview.pendingApprovals}</dd>
              <dt className="text-fg-muted">Start date</dt>
              <dd>{overview.project.startDate ?? 'Not set'}</dd>
              <dt className="text-fg-muted">Schedule version</dt>
              <dd>{overview.schedule.currentScheduleVersion}</dd>
            </dl>
            <p className="mt-3 text-xs text-fg-muted">Generated {formatDateTimeLabel(overview.generatedAt, zone)}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

async function ScheduleTab({ identity, projectId }: { identity: RequestIdentity; projectId: string }) {
  const schedule = await getSchedule(identity, projectId);
  const critical = new Set(schedule.criticalPath);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Schedule v{schedule.scheduleVersion}</CardTitle>
          <CardDescription>
            {schedule.canComputeCompletionDate && schedule.completionDate
              ? `Computed completion ${schedule.completionDate} from ${schedule.startDate ?? 'an unset start'} using ${schedule.calendarSource === 'provided' ? 'the project working calendar' : 'the Saturday/Sunday convention'}.`
              : 'The completion date cannot be computed yet; the missing inputs are listed below instead of a guess.'}
            {schedule.range ? ` Scenario range ${schedule.range.minBasedCompletionDate} to ${schedule.range.maxBasedCompletionDate} (a range, not a promise).` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {schedule.missingInputs.length > 0 ? (
            <Alert tone="warning" title="Missing inputs">
              <ul className="list-disc pl-5">
                {schedule.missingInputs.map((m) => (
                  <li key={`${m.taskKey}-${m.reason}`}>
                    {m.taskKey}: {m.detail}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {schedule.tasks.length === 0 ? (
            <EmptyState title="No schedule yet" description="The project manager builds the task list and dependencies after the budget is agreed." />
          ) : (
            <DataTable
              caption="Schedule tasks"
              rows={schedule.tasks}
              rowKey={(t) => t.id}
              rowLabel={(t) => t.name}
              columns={[
                {
                  key: 'name',
                  header: 'Task',
                  cell: (t) => (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      {critical.has(t.key) ? <Badge tone="danger">Critical path</Badge> : null}
                      {t.isMilestone ? <Badge tone="gold">Milestone</Badge> : null}
                    </span>
                  ),
                },
                { key: 'phase', header: 'Phase', cell: (t) => humanize(t.phase), hideOnMobile: true },
                { key: 'planned', header: 'Planned', cell: (t) => (t.plannedStart || t.computed ? `${t.computed?.earlyStart ?? t.plannedStart ?? '?'} → ${t.computed?.earlyFinish ?? t.plannedFinish ?? '?'}` : 'Not computed') },
                { key: 'duration', header: 'Duration (days)', cell: (t) => (t.durationDaysLikely === null ? 'Unknown' : `${t.durationDaysLikely}${t.durationDaysMin !== null && t.durationDaysMax !== null ? ` (${t.durationDaysMin}–${t.durationDaysMax})` : ''}`), hideOnMobile: true },
                { key: 'float', header: 'Float', cell: (t) => (t.computed ? `${t.computed.totalFloatDays} d` : '—'), hideOnMobile: true },
                { key: 'progress', header: 'Progress', cell: (t) => `${t.percentComplete}%${t.computed ? ` · ${humanize(t.computed.status)}` : ''}` },
                { key: 'party', header: 'Accountable', cell: (t) => humanize(t.accountableParty), hideOnMobile: true },
              ]}
            />
          )}
          {schedule.baselines.length > 0 ? (
            <p className="text-xs text-fg-muted">
              {schedule.baselines.length} baseline{schedule.baselines.length === 1 ? '' : 's'} recorded; current baseline v{schedule.baseline?.version ?? '—'}
              {schedule.baseline?.reason ? ` (${schedule.baseline.reason})` : ''}.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

async function BudgetTab({ identity, projectId, caps, zone }: { identity: RequestIdentity; projectId: string; caps: CustomerCapabilities; zone: string }) {
  const [versions, commitments, variance] = await Promise.all([
    listBudgetVersions(identity, projectId),
    listCommitments(identity, projectId, { limit: 100 }),
    getBudgetVariance(identity, projectId),
  ]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Variance</CardTitle>
          <CardDescription>Approved vs committed vs actual, commitment based. Pending change orders are shown separately and never added to the approved figure.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {[
              ['Approved total', variance.approvedTotalKobo],
              ['Contingency', variance.contingencyKobo],
              ['Committed', variance.committedKobo],
              ['Actual', variance.actualKobo],
              ['Exposure', variance.exposureKobo],
              ['Remaining', variance.remainingKobo],
              ['Forecast final cost', variance.forecastFinalCostKobo],
              ['Variance', variance.varianceKobo],
              ['Approved change orders', variance.approvedChangeOrderDeltaKobo],
              ['Pending change orders', variance.pendingChangeOrderDeltaKobo],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-fg-muted">{label}</dt>
                <dd className="tabular-nums">{value === null || value === undefined ? 'Not available' : koboToNaira(value)}</dd>
              </div>
            ))}
            <div>
              <dt className="text-fg-muted">Status</dt>
              <dd>
                <StatusBadge status={variance.status} />
              </dd>
            </div>
          </dl>
          {variance.progressExtrapolation ? (
            <p className="mt-3 text-xs text-fg-muted">
              Progress extrapolation at {variance.progressExtrapolation.percentComplete}%: {koboToNaira(variance.progressExtrapolation.finalCostKobo)} (a scenario, not a forecast).
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Budget versions</CardTitle>
          <CardDescription>Bills of quantities and their approvals. A version becomes the approved budget only when every required approval exists.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {versions.items.length === 0 ? (
            <EmptyState title="No budget version yet" description="The team drafts a budget from the accepted quote, an area rate or a bill of quantities." />
          ) : (
            versions.items
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((b) => {
                const customerPending = b.approvals.find((a) => a.approverRole === 'customer' && a.status === 'pending');
                return (
                  <section key={b.id} className="space-y-3 rounded-lg border border-border p-4" aria-labelledby={`budget-${b.id}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 id={`budget-${b.id}`} className="flex flex-wrap items-center gap-2 font-medium">
                          Version {b.version} <StatusBadge status={b.status} /> <Badge tone="neutral">{humanize(b.source)}</Badge>
                        </h3>
                        <p className="text-sm text-fg-muted">
                          Total {koboToNaira(b.totalKobo)} · contingency {koboToNaira(b.contingencyKobo)} · created {formatDateTimeLabel(b.createdAt, zone)}
                          {b.approvedAt ? ` · approved ${formatDateTimeLabel(b.approvedAt, zone)}` : ''}
                        </p>
                        {b.notes ? <p className="mt-1 text-sm text-fg-muted">{b.notes}</p> : null}
                      </div>
                      {customerPending ? (
                        <BudgetDecision budget={{ id: b.id, version: b.version }} canDecide={caps.approveChangeOrders} cannotDecideReason={capabilityNote(caps, 'Approving a budget')} totalLabel={koboToNaira(b.totalKobo)} />
                      ) : null}
                    </div>
                    {b.approvals.length > 0 ? (
                      <ul className="flex flex-wrap gap-2 text-xs">
                        {b.approvals.map((a) => (
                          <li key={a.id}>
                            <Badge tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : 'warning'}>
                              {humanize(a.approverRole)}: {humanize(a.status)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {b.items.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">{b.items.length} BOQ items</summary>
                        <div className="mt-2">
                          <DataTable
                            caption={`BOQ items for version ${b.version}`}
                            rows={b.items}
                            rowKey={(i) => i.id}
                            rowLabel={(i) => i.description}
                            columns={[
                              { key: 'code', header: 'Code', cell: (i) => i.code ?? '—', hideOnMobile: true },
                              { key: 'desc', header: 'Item', cell: (i) => i.description },
                              { key: 'qty', header: 'Qty', cell: (i) => `${i.quantity} ${i.unit}`, className: 'text-right' },
                              { key: 'rate', header: 'Rate', cell: (i) => koboToNaira(i.rateKobo), className: 'text-right', hideOnMobile: true },
                              { key: 'amount', header: 'Amount', cell: (i) => koboToNaira(i.amountKobo), className: 'text-right' },
                            ]}
                          />
                        </div>
                      </details>
                    ) : null}
                  </section>
                );
              })
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Commitments and actuals</CardTitle>
          <CardDescription>Purchase orders, contracts and invoices the team records against the budget.</CardDescription>
        </CardHeader>
        <CardContent>
          {commitments.items.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing committed or spent has been recorded yet.</p>
          ) : (
            <DataTable
              caption="Commitments"
              rows={commitments.items}
              rowKey={(c) => c.id}
              rowLabel={(c) => c.description}
              columns={[
                { key: 'kind', header: 'Kind', cell: (c) => <Badge tone={c.kind === 'actual' ? 'primary' : 'neutral'}>{humanize(c.kind)}</Badge> },
                { key: 'desc', header: 'Description', cell: (c) => c.description },
                { key: 'party', header: 'Counterparty', cell: (c) => c.counterparty ?? '—', hideOnMobile: true },
                { key: 'amount', header: 'Amount', cell: (c) => koboToNaira(c.amountKobo), className: 'text-right' },
                { key: 'date', header: 'Date', cell: (c) => c.incurredAt ?? formatDateLabel(c.createdAt, zone) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function ReportsTab({ identity, projectId, zone }: { identity: RequestIdentity; projectId: string; zone: string }) {
  const page = await listReports(identity, projectId, { limit: 100 });
  const released = page.items.filter((r) => r.status === 'released');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Released reports</CardTitle>
        <CardDescription>Only reports a named reviewer released appear here; drafts and internal reviews never do.</CardDescription>
      </CardHeader>
      <CardContent>
        {released.length === 0 ? (
          <EmptyState title="No released reports" description="Progress and inspection reports appear once reviewed and released." />
        ) : (
          <DataTable
            caption="Released reports"
            rows={released}
            rowKey={(r) => r.id}
            rowLabel={(r) => r.title}
            columns={[
              {
                key: 'title',
                header: 'Report',
                cell: (r) => (
                  <Link href={`/portal/reports/${r.id}`} className="font-medium text-primary underline">
                    {r.title}
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (r) => <Badge tone="info">{humanize(r.kind)}</Badge> },
              { key: 'version', header: 'Version', cell: (r) => `v${r.releasedVersion ?? r.currentVersion}` },
              { key: 'reviewer', header: 'Reviewed by', cell: (r) => r.namedReviewerName ?? '—', hideOnMobile: true },
              { key: 'released', header: 'Released', cell: (r) => (r.releasedAt ? formatDateLabel(r.releasedAt, zone) : '—') },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

async function MediaTab({ identity, projectId, zone }: { identity: RequestIdentity; projectId: string; zone: string }) {
  const page = await listEvidence(identity, projectId, { limit: 100 });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approved media</CardTitle>
        <CardDescription>Photos, video and drawings a reviewer approved for you. Thumbnails are derivatives; originals stay private.</CardDescription>
      </CardHeader>
      <CardContent>
        <EvidenceGallery items={page.items} zone={zone} />
        {page.nextCursor ? <p className="mt-3 text-xs text-fg-muted">Showing the latest 100 items.</p> : null}
      </CardContent>
    </Card>
  );
}

async function DefectsTab({ identity, projectId, zone }: { identity: RequestIdentity; projectId: string; zone: string }) {
  const page = await listDefects(identity, projectId, { limit: 100, unresolvedOnly: true });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unresolved defects</CardTitle>
        <CardDescription>Open, acknowledged, in-progress and disputed defects with who is accountable. Resolved defects move to the timeline.</CardDescription>
      </CardHeader>
      <CardContent>
        {page.items.length === 0 ? (
          <EmptyState title="No unresolved defects" description="Defects the inspector raises appear here until they are verified as resolved." />
        ) : (
          <DataTable
            caption="Unresolved defects"
            rows={page.items}
            rowKey={(d) => d.id}
            rowLabel={(d) => d.title}
            columns={[
              { key: 'number', header: '#', cell: (d) => (d.number !== null ? String(d.number) : '—') },
              { key: 'title', header: 'Defect', cell: (d) => <span className="font-medium">{d.title}</span> },
              { key: 'severity', header: 'Severity', cell: (d) => <Badge tone={d.severity === 'critical' || d.severity === 'safety' ? 'danger' : d.severity === 'major' ? 'warning' : 'neutral'}>{humanize(d.severity)}</Badge> },
              { key: 'status', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
              { key: 'party', header: 'Accountable', cell: (d) => humanize(d.accountableParty), hideOnMobile: true },
              { key: 'due', header: 'Due', cell: (d) => d.dueDate ?? '—' },
              { key: 'raised', header: 'Raised', cell: (d) => formatDateLabel(d.createdAt, zone), hideOnMobile: true },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

async function DecisionsTab({ identity, projectId, caps, zone }: { identity: RequestIdentity; projectId: string; caps: CustomerCapabilities; zone: string }) {
  const [changeOrders, milestones, budgets] = await Promise.all([
    listChangeOrders(identity, projectId, { limit: 100 }),
    listMilestones(identity, projectId),
    listBudgetVersions(identity, projectId),
  ]);
  const pendingBudgets = budgets.items.filter((b) => b.approvals.some((a) => a.approverRole === 'customer' && a.status === 'pending'));
  const submitted = milestones.items.filter((m) => m.status === 'submitted');
  const otherMilestones = milestones.items.filter((m) => m.status !== 'submitted');
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Change orders</CardTitle>
          <CardDescription>Budget or schedule changes proposed by the team. The budget moves only when every required approval is recorded.</CardDescription>
        </CardHeader>
        <CardContent>
          {changeOrders.items.length === 0 ? (
            <EmptyState title="No change orders" description="Budgets only move once you and staff approve a change." />
          ) : (
            <ul className="space-y-3">
              {changeOrders.items.map((c) => {
                const mine = c.approvals.find((a) => a.approverRole === 'customer');
                const awaitingMe = mine?.status === 'pending';
                return (
                  <li key={c.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          #{c.number} {c.title}
                        </span>
                        <StatusBadge status={c.status} />
                        {awaitingMe ? <Badge tone="warning">Awaiting your decision</Badge> : null}
                      </p>
                      {c.description ? <p className="whitespace-pre-wrap text-fg-muted">{c.description}</p> : null}
                      <p className="text-fg-muted">
                        Budget {c.amountDeltaKobo.startsWith('-') ? '' : '+'}
                        {koboToNaira(c.amountDeltaKobo)} · schedule {c.scheduleDeltaDays >= 0 ? '+' : ''}
                        {c.scheduleDeltaDays} day(s)
                        {c.submittedAt ? ` · submitted ${formatDateTimeLabel(c.submittedAt, zone)}` : ''}
                        {c.decidedAt ? ` · decided ${formatDateTimeLabel(c.decidedAt, zone)}` : ''}
                      </p>
                      {c.decisionNote ? <p className="text-fg-muted">Note: {c.decisionNote}</p> : null}
                      <ul className="flex flex-wrap gap-2 text-xs">
                        {c.approvals.map((a) => (
                          <li key={a.id}>
                            <Badge tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : 'warning'}>
                              {humanize(a.approverRole)}: {humanize(a.status)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {awaitingMe ? (
                      <ChangeOrderDecision
                        changeOrder={{ id: c.id, number: c.number, title: c.title, version: c.version, scheduleDeltaDays: c.scheduleDeltaDays }}
                        canDecide={caps.approveChangeOrders}
                        cannotDecideReason={capabilityNote(caps, 'Approving a change order')}
                        amountLabel={koboToNaira(c.amountDeltaKobo)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Milestone acceptance</CardTitle>
          <CardDescription>The inspector&apos;s progress estimate never implies acceptance; only your decision does.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {submitted.length === 0 ? (
            <p className="text-sm text-fg-muted">No milestone is presented for acceptance right now.</p>
          ) : (
            <ul className="space-y-3">
              {submitted.map((m) => (
                <li key={m.id} className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft/30 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.name}</span>
                      <StatusBadge status={m.status} label="Presented for acceptance" />
                    </p>
                    {m.description ? <p className="text-fg-muted">{m.description}</p> : null}
                    <p className="text-fg-muted">
                      Planned {m.plannedDate ?? '—'} · forecast {m.forecastDate ?? '—'}
                      {m.inspectorProgressPct !== null ? ` · inspector estimate ${m.inspectorProgressPct}%` : ''}
                    </p>
                  </div>
                  <MilestoneDecision milestone={{ id: m.id, name: m.name, inspectorProgressPct: m.inspectorProgressPct }} canDecide={caps.acceptMilestones} cannotDecideReason={capabilityNote(caps, 'Accepting a milestone')} />
                </li>
              ))}
            </ul>
          )}
          {otherMilestones.length > 0 ? (
            <DataTable
              caption="All milestones"
              rows={otherMilestones}
              rowKey={(m) => m.id}
              rowLabel={(m) => m.name}
              columns={[
                { key: 'name', header: 'Milestone', cell: (m) => <span className="font-medium">{m.name}</span> },
                { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
                { key: 'planned', header: 'Planned', cell: (m) => m.plannedDate ?? '—' },
                { key: 'forecast', header: 'Forecast', cell: (m) => m.forecastDate ?? '—', hideOnMobile: true },
                { key: 'progress', header: 'Inspector estimate', cell: (m) => (m.inspectorProgressPct !== null ? `${m.inspectorProgressPct}%` : '—'), hideOnMobile: true },
                { key: 'accepted', header: 'Accepted', cell: (m) => (m.customerAcceptedAt ? formatDateLabel(m.customerAcceptedAt, zone) : m.customerRejectedReason ? `Rejected: ${m.customerRejectedReason}` : '—') },
              ]}
            />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Budget approvals</CardTitle>
          <CardDescription>Budget versions waiting for your approval. Line items are on the Budget tab.</CardDescription>
        </CardHeader>
        <CardContent>
          {pendingBudgets.length === 0 ? (
            <p className="text-sm text-fg-muted">No budget version is waiting on you.</p>
          ) : (
            <ul className="space-y-3">
              {pendingBudgets.map((b) => (
                <li key={b.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <p className="font-medium">
                      Version {b.version} · {koboToNaira(b.totalKobo)} ({humanize(b.source)})
                    </p>
                    <p className="text-fg-muted">
                      <Link href={`/portal/projects/${projectId}?tab=budget`} className="underline">
                        Review the {b.items.length} line items
                      </Link>
                    </p>
                  </div>
                  <BudgetDecision budget={{ id: b.id, version: b.version }} canDecide={caps.approveChangeOrders} cannotDecideReason={capabilityNote(caps, 'Approving a budget')} totalLabel={koboToNaira(b.totalKobo)} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function TimelineTab({ identity, overview, zone }: { identity: RequestIdentity; overview: Overview; zone: string }) {
  const id = overview.project.id;
  const [milestones, changeOrders, reports, visits, defects, budgets] = await Promise.all([
    listMilestones(identity, id),
    listChangeOrders(identity, id, { limit: 100 }),
    listReports(identity, id, { limit: 100 }),
    listSiteVisits(identity, id, { limit: 100 }),
    listDefects(identity, id, { limit: 100, unresolvedOnly: false }),
    listBudgetVersions(identity, id),
  ]);
  const events = buildProjectTimeline({
    project: overview.project,
    milestones: milestones.items,
    changeOrders: changeOrders.items,
    reports: reports.items,
    visits: visits.items,
    defects: defects.items,
    budgets: budgets.items,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Derived from the project&apos;s own records (budgets, change orders, milestones, visits, reports, defects), each with the timestamp it carries. The staff audit log is not part of the customer view.</CardDescription>
      </CardHeader>
      <CardContent>
        <Timeline events={events} zone={zone} />
      </CardContent>
    </Card>
  );
}
