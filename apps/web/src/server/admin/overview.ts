import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@simplexd/db';
import { can, transact, type AdminContext } from './context';

export interface OverviewCounts {
  markets: Record<string, number> | null;
  pendingInterpretations: number | null;
  openResearchTasks: number | null;
  rankEligibleEvidence: number | null;
  activePolicyVersion: number | null;
  leads: Record<string, number> | null;
  deadJobs: number | null;
  unpublishedOutbox: number | null;
  staffCount: number | null;
  pendingPartners: number | null;
}

/** Live counts from the records the actor may see; sections the actor cannot access are null. */
export async function overviewCounts(ctx: AdminContext): Promise<OverviewCounts> {
  const marketData = can(ctx, 'market_data.read_drafts');
  const leads = can(ctx, 'leads.read');
  const ops = can(ctx, 'platform.settings.manage') || can(ctx, 'audit.read');
  const access = can(ctx, 'access.staff_roles.manage');
  const partners = can(ctx, 'access.partners.verify');
  return transact(ctx, async (tx) => {
    const out: OverviewCounts = {
      markets: null,
      pendingInterpretations: null,
      openResearchTasks: null,
      rankEligibleEvidence: null,
      activePolicyVersion: null,
      leads: null,
      deadJobs: null,
      unpublishedOutbox: null,
      staffCount: null,
      pendingPartners: null,
    };
    if (marketData) {
      const byState = await tx
        .select({ state: schema.markets.publicationState, n: sql<number>`count(*)::int` })
        .from(schema.markets)
        .groupBy(schema.markets.publicationState);
      out.markets = Object.fromEntries(byState.map((r) => [r.state, r.n]));
      const pending = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.observationInterpretations)
        .where(
          and(
            eq(schema.observationInterpretations.isCurrent, true),
            eq(
              schema.observationInterpretations.reviewStatus,
              'source_read_pending_business_review',
            ),
          ),
        );
      out.pendingInterpretations = pending[0]?.n ?? 0;
      const tasks = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.researchTasks)
        .where(sql`${schema.researchTasks.status} in ('open','in_progress','blocked')`);
      out.openResearchTasks = tasks[0]?.n ?? 0;
      const eligible = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.observationInterpretations)
        .where(
          and(
            eq(schema.observationInterpretations.isCurrent, true),
            eq(schema.observationInterpretations.publicationState, 'published'),
            eq(schema.observationInterpretations.rankEligible, true),
          ),
        );
      out.rankEligibleEvidence = eligible[0]?.n ?? 0;
      const policy = await tx
        .select({ version: schema.rankingPolicies.version })
        .from(schema.rankingPolicies)
        .where(eq(schema.rankingPolicies.status, 'active'));
      out.activePolicyVersion = policy[0]?.version ?? null;
    }
    if (leads) {
      const byStatus = await tx
        .select({ status: schema.leads.status, n: sql<number>`count(*)::int` })
        .from(schema.leads)
        .groupBy(schema.leads.status);
      out.leads = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    }
    if (ops) {
      const dead = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.jobs)
        .where(eq(schema.jobs.status, 'dead'));
      out.deadJobs = dead[0]?.n ?? 0;
      const outbox = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.outboxEvents)
        .where(isNull(schema.outboxEvents.publishedAt));
      out.unpublishedOutbox = outbox[0]?.n ?? 0;
    }
    if (access) {
      const staff = await tx
        .select({ n: sql<number>`count(distinct ${schema.staffRoles.userId})::int` })
        .from(schema.staffRoles)
        .where(isNull(schema.staffRoles.revokedAt));
      out.staffCount = staff[0]?.n ?? 0;
    }
    if (partners) {
      const pendingPartners = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.partnerProfiles)
        .where(sql`${schema.partnerProfiles.verificationStatus} in ('unverified','pending')`);
      out.pendingPartners = pendingPartners[0]?.n ?? 0;
    }
    return out;
  });
}
