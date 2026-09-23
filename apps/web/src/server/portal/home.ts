import 'server-only';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

export interface HomeCards {
  approvalsPending: { count: number; href: string };
  upcomingVisits: {
    count: number;
    next: { startsAt: string; kind: string; topic: string | null } | null;
    href: string;
  };
  invoicesDue: { count: number; outstandingKobo: string; href: string };
  latestReports: {
    items: Array<{ id: string; title: string; kind: string; releasedAt: string | null }>;
    href: string;
  };
  budgetChanges: { count: number; deltaKobo: string; href: string };
  assignedContact: {
    name: string | null;
    email: string | null;
    reference: string | null;
    href: string;
  };
  openRequests: { count: number; href: string };
}

/**
 * Every figure comes from real records visible to the caller under row-level
 * security; nothing here is hard-coded. Empty organisations show zeros, and the
 * page explains what fills each card.
 */
export async function loadHomeCards(identity: RequestIdentity): Promise<HomeCards> {
  const orgId = identity.ctx.organizationId;
  const empty: HomeCards = {
    approvalsPending: { count: 0, href: '/portal/projects' },
    upcomingVisits: { count: 0, next: null, href: '/portal/appointments' },
    invoicesDue: { count: 0, outstandingKobo: '0', href: '/portal/invoices' },
    latestReports: { items: [], href: '/portal/documents' },
    budgetChanges: { count: 0, deltaKobo: '0', href: '/portal/projects' },
    assignedContact: { name: null, email: null, reference: null, href: '/portal/messages' },
    openRequests: { count: 0, href: '/portal/requests' },
  };
  if (!orgId) return empty;
  const now = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [approvals] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.organizationId, orgId),
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.approverRole, 'customer'),
        ),
      );
    const visits = await tx
      .select({
        startsAt: schema.appointments.startsAt,
        kind: schema.appointments.kind,
        topic: schema.appointments.topic,
      })
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.organizationId, orgId),
          gte(schema.appointments.startsAt, now),
          inArray(schema.appointments.status, ['pending_confirmation', 'confirmed', 'rescheduled']),
        ),
      )
      .orderBy(schema.appointments.startsAt);
    const [invoices] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        outstanding: sql<string>`coalesce(sum(${schema.invoices.totalKobo} - ${schema.invoices.amountPaidKobo} - ${schema.invoices.amountCreditedKobo}), 0)::text`,
      })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.organizationId, orgId),
          inArray(schema.invoices.status, ['issued', 'partially_paid', 'overdue']),
        ),
      );
    const reports = await tx
      .select({
        id: schema.reports.id,
        title: schema.reports.title,
        kind: schema.reports.kind,
        releasedAt: schema.reports.releasedAt,
      })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.organizationId, orgId),
          eq(schema.reports.status, 'released'),
          eq(schema.reports.customerVisible, true),
        ),
      )
      .orderBy(desc(schema.reports.releasedAt))
      .limit(3);
    const [changes] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        delta: sql<string>`coalesce(sum(${schema.changeOrders.amountDeltaKobo}), 0)::text`,
      })
      .from(schema.changeOrders)
      .where(
        and(
          eq(schema.changeOrders.organizationId, orgId),
          eq(schema.changeOrders.status, 'approved'),
        ),
      );
    const [contact] = await tx
      .select({
        name: schema.user.name,
        email: schema.user.email,
        reference: schema.serviceRequests.reference,
      })
      .from(schema.serviceRequests)
      .innerJoin(schema.user, eq(schema.user.id, schema.serviceRequests.assignedPmUserId))
      .where(
        and(
          eq(schema.serviceRequests.organizationId, orgId),
          isNotNull(schema.serviceRequests.assignedPmUserId),
        ),
      )
      .orderBy(desc(schema.serviceRequests.updatedAt))
      .limit(1);
    const [open] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.serviceRequests)
      .where(
        and(
          eq(schema.serviceRequests.organizationId, orgId),
          inArray(schema.serviceRequests.status, [
            'inquiry',
            'triage',
            'quoted',
            'accepted',
            'awaiting_payment',
            'in_progress',
            'in_review',
            'delivered',
            'paused',
          ]),
        ),
      );
    const nextVisit = visits[0];
    return {
      approvalsPending: { count: approvals?.count ?? 0, href: '/portal/projects' },
      upcomingVisits: {
        count: visits.length,
        next: nextVisit
          ? {
              startsAt: nextVisit.startsAt.toISOString(),
              kind: nextVisit.kind,
              topic: nextVisit.topic,
            }
          : null,
        href: '/portal/appointments',
      },
      invoicesDue: {
        count: invoices?.count ?? 0,
        outstandingKobo: invoices?.outstanding ?? '0',
        href: '/portal/invoices',
      },
      latestReports: {
        items: reports.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          releasedAt: r.releasedAt?.toISOString() ?? null,
        })),
        href: '/portal/documents',
      },
      budgetChanges: {
        count: changes?.count ?? 0,
        deltaKobo: changes?.delta ?? '0',
        href: '/portal/projects',
      },
      assignedContact: {
        name: contact?.name ?? null,
        email: contact?.email ?? null,
        reference: contact?.reference ?? null,
        href: '/portal/messages',
      },
      openRequests: { count: open?.count ?? 0, href: '/portal/requests' },
    };
  });
}
