import 'server-only';
import type { ProjectOverviewDto, StaffAssigneeDto } from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';
import { listAssignments } from '@/server/assignments/service';
import { listStaffAssignees } from '@/server/leads/admin';
import { getProjectOverview } from '@/server/projects/projects';
import { can, orgNames, staffTx } from './context';
import { listInvitablePartners } from './partners';

export interface ProjectPermissions {
  manage: boolean;
  reportsDraft: boolean;
  reportsReview: boolean;
  reportsRelease: boolean;
  changeOrdersApprove: boolean;
  milestoneProgress: boolean;
  financeAuthorize: boolean;
  evidenceApprove: boolean;
  siteVisits: boolean;
  assign: boolean;
}

export interface ProjectShell {
  overview: ProjectOverviewDto;
  organizationName: string;
  staff: StaffAssigneeDto[];
  partners: Array<{ userId: string; name: string; partnerType: string; verificationStatus: string }>;
  assignments: Awaited<ReturnType<typeof listAssignments>>['items'];
  permissions: ProjectPermissions;
}

/** Header data shared by every project tab. */
export async function projectShell(identity: RequestIdentity, projectId: string): Promise<ProjectShell> {
  const overview = await getProjectOverview(identity, projectId);
  const [names, staff, partners, assignments] = await Promise.all([
    staffTx(identity, (tx) => orgNames(tx, [overview.project.organizationId])),
    listStaffAssignees(identity),
    listInvitablePartners(identity).catch(() => []),
    listAssignments(identity, { projectId, limit: 100 }).then((p) => p.items),
  ]);
  return {
    overview,
    organizationName: names.get(overview.project.organizationId) ?? overview.project.organizationId,
    staff,
    partners: partners.map((p) => ({ userId: p.userId, name: p.name, partnerType: p.partnerType, verificationStatus: p.verificationStatus })),
    assignments,
    permissions: {
      manage: can(identity, 'projects.manage'),
      reportsDraft: can(identity, 'reports.draft'),
      reportsReview: can(identity, 'reports.review'),
      reportsRelease: can(identity, 'reports.release'),
      changeOrdersApprove: can(identity, 'change_orders.staff_approve'),
      milestoneProgress: can(identity, 'milestones.record_progress'),
      financeAuthorize: can(identity, 'milestones.finance_authorize'),
      evidenceApprove: can(identity, 'evidence.approve'),
      siteVisits: can(identity, 'projects.manage') || can(identity, 'site_visits.perform'),
      assign: can(identity, 'projects.manage') || can(identity, 'service_requests.assign'),
    },
  };
}
