import 'server-only';
import { and, asc, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Portal list read models. Each query is scoped by the active organisation and
 * additionally by row-level security, so a stale session can never read
 * another organisation's rows. Records appear once an engagement creates them;
 * the pages explain that honestly instead of showing samples.
 */

export interface PropertyListItem {
  id: string;
  name: string;
  kind: string;
  marketName: string | null;
  titleStatus: string;
  status: string;
  updatedAt: string;
}

export async function listProperties(identity: RequestIdentity): Promise<PropertyListItem[]> {
  const orgId = identity.ctx.organizationId;
  if (!orgId) return [];
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ p: schema.properties, marketName: schema.markets.name })
      .from(schema.properties)
      .leftJoin(schema.markets, eq(schema.markets.id, schema.properties.marketId))
      .where(and(eq(schema.properties.organizationId, orgId), isNull(schema.properties.archivedAt)))
      .orderBy(desc(schema.properties.updatedAt)),
  );
  return rows.map((r) => ({
    id: r.p.id,
    name: r.p.name,
    kind: r.p.kind,
    marketName: r.marketName,
    titleStatus: r.p.titleStatus,
    status: r.p.status,
    updatedAt: r.p.updatedAt.toISOString(),
  }));
}

export interface ProjectListItem {
  id: string;
  name: string;
  kind: string;
  status: string;
  targetCompletionDate: string | null;
  forecastCompletionDate: string | null;
  pmName: string | null;
  pendingApprovals: number;
}

export async function listProjects(identity: RequestIdentity): Promise<ProjectListItem[]> {
  const orgId = identity.ctx.organizationId;
  if (!orgId) return [];
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({ p: schema.projects, pmName: schema.user.name })
      .from(schema.projects)
      .leftJoin(schema.user, eq(schema.user.id, schema.projects.pmUserId))
      .where(and(eq(schema.projects.organizationId, orgId), isNull(schema.projects.archivedAt)))
      .orderBy(desc(schema.projects.updatedAt));
    const approvals = await tx
      .select({ entityId: schema.approvals.entityId, count: sql<number>`count(*)::int` })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.organizationId, orgId),
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.approverRole, 'customer'),
        ),
      )
      .groupBy(schema.approvals.entityId);
    const pending = new Map(approvals.map((a) => [a.entityId, a.count]));
    return rows.map((r) => ({
      id: r.p.id,
      name: r.p.name,
      kind: r.p.kind,
      status: r.p.status,
      targetCompletionDate: r.p.targetCompletionDate,
      forecastCompletionDate: r.p.forecastCompletionDate,
      pmName: r.pmName,
      pendingApprovals: pending.get(r.p.id) ?? 0,
    }));
  });
}

export interface DocumentListItem {
  id: string;
  name: string;
  purpose: string;
  mime: string;
  sizeBytes: number | null;
  status: string;
  createdAt: string;
}

export interface ReleasedReportItem {
  id: string;
  title: string;
  kind: string;
  releasedAt: string | null;
  releasedVersion: number | null;
}

export async function listDocuments(
  identity: RequestIdentity,
): Promise<{ files: DocumentListItem[]; reports: ReleasedReportItem[] }> {
  const orgId = identity.ctx.organizationId;
  if (!orgId) return { files: [], reports: [] };
  return withActor(getDb(), identity.ctx, async (tx) => {
    const files = await tx
      .select()
      .from(schema.fileObjects)
      .where(
        and(
          eq(schema.fileObjects.organizationId, orgId),
          isNull(schema.fileObjects.deletedAt),
          sql`${schema.fileObjects.status} IN ('uploaded','scanning','clean')`,
        ),
      )
      .orderBy(desc(schema.fileObjects.createdAt))
      .limit(200);
    const reports = await tx
      .select({
        id: schema.reports.id,
        title: schema.reports.title,
        kind: schema.reports.kind,
        releasedAt: schema.reports.releasedAt,
        releasedVersion: schema.reports.releasedVersion,
      })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.organizationId, orgId),
          eq(schema.reports.status, 'released'),
          eq(schema.reports.customerVisible, true),
        ),
      )
      .orderBy(desc(schema.reports.releasedAt));
    return {
      files: files.map((f) => ({
        id: f.id,
        name: f.originalName,
        purpose: f.purpose,
        mime: f.detectedMime ?? f.declaredMime,
        sizeBytes: f.sizeBytes,
        status: f.status,
        createdAt: f.createdAt.toISOString(),
      })),
      reports: reports.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        releasedAt: r.releasedAt?.toISOString() ?? null,
        releasedVersion: r.releasedVersion,
      })),
    };
  });
}

export interface InvoiceListItem {
  id: string;
  number: string;
  kind: string;
  status: string;
  totalKobo: string;
  paidKobo: string;
  outstandingKobo: string;
  currency: string;
  dueDate: string | null;
  issuedAt: string | null;
}

export async function listInvoices(identity: RequestIdentity): Promise<InvoiceListItem[]> {
  const orgId = identity.ctx.organizationId;
  if (!orgId) return [];
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.invoices)
      .where(
        and(eq(schema.invoices.organizationId, orgId), sql`${schema.invoices.status} <> 'draft'`),
      )
      .orderBy(desc(schema.invoices.issuedAt), desc(schema.invoices.createdAt)),
  );
  return rows.map((i) => ({
    id: i.id,
    number: i.number,
    kind: i.kind,
    status: i.status,
    totalKobo: i.totalKobo.toString(),
    paidKobo: i.amountPaidKobo.toString(),
    outstandingKobo: (i.totalKobo - i.amountPaidKobo - i.amountCreditedKobo).toString(),
    currency: i.currency,
    dueDate: i.dueDate,
    issuedAt: i.issuedAt?.toISOString() ?? null,
  }));
}

export interface AppointmentListItem {
  id: string;
  kind: string;
  status: string;
  startsAt: string;
  endsAt: string;
  customerTimeZone: string;
  businessTimeZone: string;
  topic: string | null;
  meetingProvider: string;
  conferenceStatus: string;
  hasMeetingUrl: boolean;
  staffName: string | null;
}

export async function listAppointments(
  identity: RequestIdentity,
): Promise<{ upcoming: AppointmentListItem[]; past: AppointmentListItem[] }> {
  if (!identity.session) return { upcoming: [], past: [] };
  const orgId = identity.ctx.organizationId;
  const userId = identity.session.user.id;
  const now = new Date();
  const scope = orgId
    ? or(
        eq(schema.appointments.organizationId, orgId),
        eq(schema.appointments.customerUserId, userId),
      )
    : eq(schema.appointments.customerUserId, userId);
  const map = (r: {
    a: typeof schema.appointments.$inferSelect;
    staffName: string | null;
  }): AppointmentListItem => ({
    id: r.a.id,
    kind: r.a.kind,
    status: r.a.status,
    startsAt: r.a.startsAt.toISOString(),
    endsAt: r.a.endsAt.toISOString(),
    customerTimeZone: r.a.customerTimeZone,
    businessTimeZone: r.a.businessTimeZone,
    topic: r.a.topic,
    meetingProvider: r.a.meetingProvider,
    conferenceStatus: r.a.conferenceStatus,
    hasMeetingUrl: Boolean(r.a.meetingUrl),
    staffName: r.staffName,
  });
  return withActor(getDb(), identity.ctx, async (tx) => {
    const base = () =>
      tx
        .select({ a: schema.appointments, staffName: schema.user.name })
        .from(schema.appointments)
        .leftJoin(schema.user, eq(schema.user.id, schema.appointments.staffUserId));
    const upcoming = await base()
      .where(and(scope, gte(schema.appointments.startsAt, now)))
      .orderBy(asc(schema.appointments.startsAt))
      .limit(100);
    const past = await base()
      .where(and(scope, lt(schema.appointments.startsAt, now)))
      .orderBy(desc(schema.appointments.startsAt))
      .limit(50);
    return { upcoming: upcoming.map(map), past: past.map(map) };
  });
}

export interface ConversationListItem {
  id: string;
  subject: string;
  kind: string;
  lastMessageAt: string | null;
  closedAt: string | null;
  unread: boolean;
}

export async function listConversations(
  identity: RequestIdentity,
): Promise<ConversationListItem[]> {
  if (!identity.session) return [];
  const userId = identity.session.user.id;
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ c: schema.conversations, lastReadAt: schema.conversationParticipants.lastReadAt })
      .from(schema.conversations)
      .innerJoin(
        schema.conversationParticipants,
        and(
          eq(schema.conversationParticipants.conversationId, schema.conversations.id),
          eq(schema.conversationParticipants.userId, userId),
          isNull(schema.conversationParticipants.leftAt),
        ),
      )
      .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.createdAt))
      .limit(100),
  );
  return rows.map((r) => ({
    id: r.c.id,
    subject: r.c.subject,
    kind: r.c.kind,
    lastMessageAt: r.c.lastMessageAt?.toISOString() ?? null,
    closedAt: r.c.closedAt?.toISOString() ?? null,
    unread: Boolean(r.c.lastMessageAt && (!r.lastReadAt || r.lastReadAt < r.c.lastMessageAt)),
  }));
}

export interface ScenarioListItem {
  id: string;
  name: string;
  objective: string;
  mode: string;
  marketCount: number;
  ownedByMe: boolean;
  convertedServiceRequestId: string | null;
  updatedAt: string;
}

/** Scenarios the user owns or the active organisation holds (row-level security). */
export async function listScenarios(identity: RequestIdentity): Promise<ScenarioListItem[]> {
  if (!identity.session) return [];
  const userId = identity.session.user.id;
  const orgId = identity.ctx.organizationId;
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.scenarios)
      .where(
        orgId
          ? or(eq(schema.scenarios.ownerUserId, userId), eq(schema.scenarios.organizationId, orgId))
          : eq(schema.scenarios.ownerUserId, userId),
      )
      .orderBy(desc(schema.scenarios.updatedAt))
      .limit(100),
  );
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    objective: s.objective,
    mode: s.mode,
    marketCount: s.marketIds.length,
    ownedByMe: s.ownerUserId === userId,
    convertedServiceRequestId: s.convertedServiceRequestId,
    updatedAt: s.updatedAt.toISOString(),
  }));
}
