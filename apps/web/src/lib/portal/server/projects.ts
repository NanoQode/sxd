import 'server-only';
import type {
  BudgetVersionDto,
  ChangeOrderDto,
  DefectDto,
  MilestoneDto,
  ProjectDto,
  ReportDto,
  SiteVisitDto,
} from '@simplexd/contracts';
import type { TimelineEvent } from './properties';

/**
 * Project timeline assembled from customer-visible records. The append-only
 * audit log is not readable by customers, so every entry here is derived from
 * the same rows the tabs show (with who and when where the record carries it).
 */
export function buildProjectTimeline(input: {
  project: ProjectDto;
  milestones: MilestoneDto[];
  changeOrders: ChangeOrderDto[];
  reports: ReportDto[];
  visits: SiteVisitDto[];
  defects: DefectDto[];
  budgets: BudgetVersionDto[];
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const p = input.project;
  events.push({
    id: `project-created-${p.id}`,
    at: p.createdAt,
    title: 'Project opened',
    detail: `${p.name} (${p.kind.replace(/_/g, ' ')})`,
    kind: 'project',
  });
  if (p.startDate) {
    events.push({
      id: `project-start-${p.id}`,
      at: `${p.startDate}T00:00:00.000Z`,
      title: 'Planned start',
      detail: null,
      kind: 'project',
    });
  }
  for (const b of input.budgets) {
    events.push({
      id: `budget-${b.id}`,
      at: b.createdAt,
      title: `Budget version ${b.version} drafted`,
      detail: `${b.source.replace(/_/g, ' ')} · status ${b.status}`,
      kind: 'budget',
      href: `/portal/projects/${p.id}?tab=budget`,
    });
    if (b.approvedAt) {
      events.push({
        id: `budget-approved-${b.id}`,
        at: b.approvedAt,
        title: `Budget version ${b.version} approved`,
        detail: b.approvedByCustomerUserId ? 'Customer and staff approvals recorded.' : 'Approved.',
        kind: 'budget',
        href: `/portal/projects/${p.id}?tab=budget`,
      });
    }
  }
  for (const c of input.changeOrders) {
    if (c.submittedAt) {
      events.push({
        id: `co-submitted-${c.id}`,
        at: c.submittedAt,
        title: `Change order #${c.number} submitted`,
        detail: c.title,
        kind: 'change_order',
        href: `/portal/projects/${p.id}?tab=decisions`,
      });
    }
    if (c.decidedAt) {
      events.push({
        id: `co-decided-${c.id}`,
        at: c.decidedAt,
        title: `Change order #${c.number} ${c.status.replace(/_/g, ' ')}`,
        detail: c.decisionNote,
        kind: 'change_order',
        href: `/portal/projects/${p.id}?tab=decisions`,
      });
    }
  }
  for (const m of input.milestones) {
    if (m.inspectorProgressAt) {
      events.push({
        id: `ms-progress-${m.id}`,
        at: m.inspectorProgressAt,
        title: `Inspector progress on ${m.name}`,
        detail:
          m.inspectorProgressPct !== null
            ? `${m.inspectorProgressPct}% estimated (not an acceptance)`
            : null,
        kind: 'milestone',
      });
    }
    if (m.customerAcceptedAt) {
      events.push({
        id: `ms-accepted-${m.id}`,
        at: m.customerAcceptedAt,
        title: `Milestone ${m.name} accepted`,
        detail: null,
        kind: 'milestone',
      });
    }
    if (m.status === 'rejected' && m.customerRejectedReason) {
      events.push({
        id: `ms-rejected-${m.id}`,
        at: m.updatedAt,
        title: `Milestone ${m.name} rejected`,
        detail: m.customerRejectedReason,
        kind: 'milestone',
      });
    }
    if (m.financeAuthorizedAt) {
      events.push({
        id: `ms-finance-${m.id}`,
        at: m.financeAuthorizedAt,
        title: `Payment authorised for ${m.name}`,
        detail: null,
        kind: 'milestone',
      });
    }
  }
  for (const r of input.reports) {
    if (r.releasedAt) {
      events.push({
        id: `report-${r.id}`,
        at: r.releasedAt,
        title: `Report released: ${r.title}`,
        detail: `${r.kind.replace(/_/g, ' ')} · version ${r.releasedVersion ?? r.currentVersion}`,
        kind: 'report',
        href: `/portal/reports/${r.id}`,
      });
    }
  }
  for (const v of input.visits) {
    const at = v.reviewedAt ?? v.submittedAt ?? v.startedAt ?? v.scheduledAt;
    if (!at) continue;
    events.push({
      id: `visit-${v.id}`,
      at,
      title: `Site visit ${v.status.replace(/_/g, ' ')}`,
      detail: v.inspectorName ? `Inspector: ${v.inspectorName}` : null,
      kind: 'visit',
    });
  }
  for (const d of input.defects) {
    events.push({
      id: `defect-${d.id}`,
      at: d.createdAt,
      title: `Defect ${d.number !== null ? `#${d.number} ` : ''}raised: ${d.title}`,
      detail: `${d.severity} · ${d.status.replace(/_/g, ' ')}`,
      kind: 'defect',
      href: `/portal/projects/${p.id}?tab=defects`,
    });
    if (d.resolvedAt) {
      events.push({
        id: `defect-resolved-${d.id}`,
        at: d.resolvedAt,
        title: `Defect resolved: ${d.title}`,
        detail: null,
        kind: 'defect',
      });
    }
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
