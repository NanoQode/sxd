import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import type {
  AwardDto,
  AwardOutcomeDto,
  BidReadDto,
  TenderComparisonDto,
  TenderDetail,
  TenderDto,
  TenderListQuery,
} from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { getAward } from '@/server/tenders/awards';
import { listTenderBids } from '@/server/tenders/bids';
import { getTenderComparison } from '@/server/tenders/evaluation';
import { getTender, listTenders } from '@/server/tenders/tenders';
import { attempt, can, orgNames, staffTx, userNames, type Loaded } from './context';
import { listInvitablePartners } from './partners';

export interface TenderListRow extends TenderDto {
  organizationName: string;
  projectName: string | null;
}

export async function listTendersView(
  identity: RequestIdentity,
  query: TenderListQuery,
): Promise<{ items: TenderListRow[]; nextCursor: string | null }> {
  const page = await listTenders(identity, query);
  const extras = await staffTx(identity, async (tx) => {
    const orgs = await orgNames(
      tx,
      page.items.map((t) => t.organizationId),
    );
    const projectIds = [
      ...new Set(page.items.map((t) => t.projectId).filter((v): v is string => Boolean(v))),
    ];
    const projects = projectIds.length
      ? await tx
          .select({ id: schema.projects.id, name: schema.projects.name })
          .from(schema.projects)
          .where(inArray(schema.projects.id, projectIds))
      : [];
    return { orgs, projects: new Map(projects.map((p) => [p.id, p.name])) };
  });
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((t) => ({
      ...t,
      organizationName: extras.orgs.get(t.organizationId) ?? t.organizationId,
      projectName: t.projectId ? (extras.projects.get(t.projectId) ?? null) : null,
    })),
  };
}

export interface TenderWorkspace {
  tender: TenderDetail;
  organizationName: string;
  projectName: string | null;
  createdByName: string | null;
  bids: Loaded<BidReadDto[]>;
  comparison: Loaded<TenderComparisonDto>;
  award: AwardDto | null;
  partners: Array<{
    userId: string;
    name: string;
    email: string;
    partnerType: string;
    verificationStatus: string;
  }>;
  askerNames: Record<string, string>;
  permissions: { manage: boolean; evaluate: boolean; openSealed: boolean; mfaVerified: boolean };
}

/** Everything the staff tender page needs; reads that the actor may not perform come back as refusals, not page errors. */
export async function tenderWorkspace(
  identity: RequestIdentity,
  id: string,
): Promise<TenderWorkspace> {
  const tender = await getTender(identity, id);
  const permissions = {
    manage: can(identity, 'tenders.manage'),
    evaluate: can(identity, 'bids.evaluate'),
    openSealed: can(identity, 'bids.open_sealed'),
    mfaVerified: identity.actor.mfaVerified,
  };
  const [bids, comparison, award, partners, extras] = await Promise.all([
    attempt(() => listTenderBids(identity, id)),
    attempt(() => getTenderComparison(identity, id)),
    attempt(() => getAward(identity, id)),
    permissions.manage ? listInvitablePartners(identity).catch(() => []) : Promise.resolve([]),
    staffTx(identity, async (tx) => {
      const orgs = await orgNames(tx, [tender.organizationId]);
      const [project] = tender.projectId
        ? await tx
            .select({ name: schema.projects.name })
            .from(schema.projects)
            .where(eq(schema.projects.id, tender.projectId))
        : [];
      const names = await userNames(tx, [
        tender.createdBy,
        ...tender.questions.map((q) => q.askedByUserId),
      ]);
      return {
        orgName: orgs.get(tender.organizationId) ?? tender.organizationId,
        projectName: project?.name ?? null,
        names,
      };
    }),
  ]);
  const awardValue =
    award.ok && 'bidId' in (award.value as AwardDto | AwardOutcomeDto)
      ? (award.value as AwardDto)
      : null;
  return {
    tender,
    organizationName: extras.orgName,
    projectName: extras.projectName,
    createdByName: tender.createdBy ? (extras.names.get(tender.createdBy)?.name ?? null) : null,
    bids,
    comparison,
    award: awardValue,
    partners,
    askerNames: Object.fromEntries([...extras.names.entries()].map(([k, v]) => [k, v.name])),
    permissions,
  };
}
