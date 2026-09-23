import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { projectStatusSchema } from '@simplexd/contracts';
import { Alert, Badge, PageHeader, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { projectShell } from '@/lib/admin/server/projects';
import { ApiAction } from '@/components/admin/api-action';
import { AssignmentsPanel } from '@/components/admin/assignments-panel';
import { Money } from '@/components/admin/money';
import { Section, TabLink, TabNav } from '@/components/admin/section';
import { DefinitionList, StatTile } from '../../_components/bits';
import { BudgetTab } from './_tabs/budget-tab';
import { ChangeOrdersTab } from './_tabs/change-orders-tab';
import { DefectsTab } from './_tabs/defects-tab';
import { DesignTab } from './_tabs/design-tab';
import { EvidenceTab } from './_tabs/evidence-tab';
import { MilestonesTab } from './_tabs/milestones-tab';
import { PermitsTab } from './_tabs/permits-tab';
import { ReportsTab } from './_tabs/reports-tab';
import { ScheduleTab } from './_tabs/schedule-tab';
import { VisitsTab } from './_tabs/visits-tab';

export const metadata: Metadata = { title: 'Project' };
export const dynamic = 'force-dynamic';

const TABS = [
  ['overview', 'Overview'],
  ['budget', 'Budget & BOQ'],
  ['schedule', 'Schedule'],
  ['milestones', 'Milestones'],
  ['visits', 'Site visits'],
  ['reports', 'Reports'],
  ['evidence', 'Evidence'],
  ['defects', 'Defects'],
  ['change-orders', 'Change orders'],
  ['permits', 'Permits'],
  ['design', 'Design'],
] as const;

type Tab = (typeof TABS)[number][0];

const NEXT_STATES: Record<string, Array<{ to: string; reason: boolean }>> = {
  planning: [{ to: 'active', reason: false }, { to: 'cancelled', reason: true }],
  active: [{ to: 'on_hold', reason: true }, { to: 'completed', reason: false }, { to: 'cancelled', reason: true }],
  on_hold: [{ to: 'active', reason: false }, { to: 'cancelled', reason: true }],
  completed: [{ to: 'archived', reason: false }],
  cancelled: [{ to: 'archived', reason: false }],
  archived: [],
};

export default async function ProjectDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireStaffPage('projects.read_all');
  const { id } = await params;
  const raw = await searchParams;
  const tab: Tab = (TABS.find(([k]) => k === raw.tab)?.[0] ?? 'overview') as Tab;
  let shell;
  try {
    shell = await projectShell(identity, id);
  } catch {
    notFound();
  }
  const { overview, permissions } = shell;
  const p = overview.project;
  const variance = overview.budget.variance;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/projects" className="underline">
            Projects
          </Link>
        }
        title={p.name}
        description={`${humanize(p.kind)} · ${shell.organizationName}`}
        actions={
          <>
            <StatusBadge status={p.status === 'active' ? 'in_progress' : p.status === 'planning' ? 'draft' : p.status} label={humanize(p.status)} />
            {permissions.manage
              ? (NEXT_STATES[p.status] ?? []).map((t) => (
                  <ApiAction
                    key={t.to}
                    path={`/api/v1/projects/${p.id}/transitions`}
                    label={humanize(t.to)}
                    variant={t.to === 'cancelled' ? 'danger' : 'secondary'}
                    body={(reason) => ({ to: t.to, reason: reason || undefined, expectedVersion: p.version })}
                    confirm={{ title: `Move project to ${humanize(t.to)}?`, requireReason: t.reason, confirmLabel: humanize(t.to), tone: t.to === 'cancelled' ? 'danger' : 'primary' }}
                    successMessage={`Project ${humanize(t.to)}`}
                  />
                ))
              : null}
          </>
        }
      />
      <TabNav label="Project sections">
        {TABS.map(([key, label]) => (
          <TabLink key={key} href={`/admin/projects/${p.id}?tab=${key}`} active={tab === key}>
            {label}
          </TabLink>
        ))}
      </TabNav>

      {tab === 'overview' ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Approved budget" value={variance.approvedTotalKobo ? <Money kobo={variance.approvedTotalKobo} compact /> : 'none'} href={`/admin/projects/${p.id}?tab=budget`} tone={variance.hasApprovedBudget ? 'neutral' : 'warning'} hint={variance.hasApprovedBudget ? `v${overview.budget.approvedVersion}` : 'No approved version'} />
            <StatTile label="Committed + actual" value={<Money kobo={variance.exposureKobo} compact />} href={`/admin/projects/${p.id}?tab=budget`} tone={variance.status === 'over_committed' || variance.status === 'over_spent' ? 'danger' : 'neutral'} hint={humanize(variance.status)} />
            <StatTile label="Forecast completion" value={overview.schedule.forecastCompletionDate ? formatDateLabel(overview.schedule.forecastCompletionDate) : 'unknown'} href={`/admin/projects/${p.id}?tab=schedule`} hint={humanize(overview.schedule.forecastSource)} />
            <StatTile label="Open defects" value={overview.defects.open} href={`/admin/projects/${p.id}?tab=defects`} tone={overview.defects.open > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Milestones" value={overview.milestones.total} href={`/admin/projects/${p.id}?tab=milestones`} hint={overview.milestones.nextPlannedDate ? `next ${formatDateLabel(overview.milestones.nextPlannedDate)}` : undefined} />
            <StatTile label="Pending change orders" value={overview.changeOrders.pending} href={`/admin/projects/${p.id}?tab=change-orders`} tone={overview.changeOrders.pending > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Pending approvals" value={overview.pendingApprovals} href={`/admin/projects/${p.id}?tab=change-orders`} />
            <StatTile label="Latest released report" value={overview.latestReleasedReport ? `v${overview.latestReleasedReport.releasedVersion}` : 'none'} href={`/admin/projects/${p.id}?tab=reports`} hint={overview.latestReleasedReport?.title} />
          </div>
          {variance.notes.length > 0 ? (
            <Alert tone="info" title="Budget notes">
              <ul className="list-disc pl-5">
                {variance.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Details">
              <DefinitionList
                items={[
                  { term: 'Organisation', value: <Link href={`/admin/customers/${p.organizationId}`} className="underline">{shell.organizationName}</Link> },
                  { term: 'Service request', value: p.serviceRequestId ? <Link href={`/admin/service-requests/${p.serviceRequestId}`} className="underline">Open request</Link> : null },
                  { term: 'Property', value: p.propertyId ? <Link href={`/admin/properties/${p.propertyId}`} className="underline">Open property</Link> : null },
                  { term: 'Project manager', value: overview.team.find((t) => t.source === 'project_manager')?.name ?? null },
                  { term: 'Customer contact', value: overview.team.find((t) => t.source === 'customer_contact')?.name ?? null },
                  { term: 'Start', value: p.startDate ? formatDateLabel(p.startDate) : null },
                  { term: 'Target completion', value: p.targetCompletionDate ? formatDateLabel(p.targetCompletionDate) : null },
                  { term: 'Gross floor area', value: p.grossFloorAreaM2 ? `${p.grossFloorAreaM2} m²` : null },
                  { term: 'Schedule version', value: `v${overview.schedule.currentScheduleVersion} · ${overview.schedule.taskCount} tasks${overview.schedule.percentComplete !== null ? ` · ${overview.schedule.percentComplete}% complete` : ''}` },
                ]}
              />
              {p.description ? <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">{p.description}</p> : null}
              <p className="text-xs text-fg-muted">Allowed statuses: {projectStatusSchema.options.map(humanize).join(', ')}.</p>
            </Section>
            <Section title="Team and assignments" description="Assignments give inspectors, surveyors and partners access to this project after acceptance.">
              <ul className="mb-3 flex flex-wrap gap-2">
                {overview.team.map((t) => (
                  <li key={`${t.userId}-${t.source}`}>
                    <Badge tone={t.source === 'project_manager' ? 'primary' : 'neutral'}>
                      {t.name ?? t.userId} · {humanize(t.role)}
                    </Badge>
                  </li>
                ))}
              </ul>
              <AssignmentsPanel
                target={{ projectId: p.id }}
                assignments={shell.assignments}
                assignees={[
                  ...shell.staff.map((s) => ({ userId: s.userId, name: s.name, kind: 'staff' as const, detail: s.roles.map(humanize).join(', ') })),
                  ...shell.partners.map((x) => ({ userId: x.userId, name: x.name, kind: 'partner' as const, detail: `${humanize(x.partnerType)} · ${humanize(x.verificationStatus)}` })),
                ]}
                canAssign={permissions.assign}
              />
            </Section>
          </div>
        </div>
      ) : null}
      {tab === 'budget' ? <BudgetTab identity={identity} shell={shell} /> : null}
      {tab === 'schedule' ? <ScheduleTab identity={identity} shell={shell} /> : null}
      {tab === 'milestones' ? <MilestonesTab identity={identity} shell={shell} /> : null}
      {tab === 'visits' ? <VisitsTab identity={identity} shell={shell} /> : null}
      {tab === 'reports' ? <ReportsTab identity={identity} shell={shell} /> : null}
      {tab === 'evidence' ? <EvidenceTab identity={identity} shell={shell} /> : null}
      {tab === 'defects' ? <DefectsTab identity={identity} shell={shell} /> : null}
      {tab === 'change-orders' ? <ChangeOrdersTab identity={identity} shell={shell} /> : null}
      {tab === 'permits' ? <PermitsTab identity={identity} shell={shell} /> : null}
      {tab === 'design' ? <DesignTab identity={identity} shell={shell} /> : null}
    </div>
  );
}
