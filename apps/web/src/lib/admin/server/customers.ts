import 'server-only';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { InvoiceDto, PropertyDto } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { listInvoices } from '@simplexd/finance';
import type { RequestIdentity } from '@/lib/auth/session';
import { listProperties } from '@/server/properties/service';
import { can, financeFor, iso, maskEmail, maskPhone, requireAnyStaff, staffTx } from './context';

export interface CustomerOrgRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  ownershipType: string | null;
  countryCode: string | null;
  memberCount: number;
  requestCount: number;
  openRequestCount: number;
  createdAt: string;
}

/** Customer organisations (needs `customers.read`). Staff/partner/estate organisations are excluded. */
export async function listCustomerOrganizations(
  identity: RequestIdentity,
  filters: { q?: string; page: number; pageSize: number },
): Promise<{ items: CustomerOrgRow[]; total: number }> {
  requireAnyStaff(identity, ['customers.read']);
  return staffTx(identity, async (tx) => {
    const where = and(
      or(
        isNull(schema.organizationProfiles.kind),
        eq(schema.organizationProfiles.kind, 'customer'),
      ),
      filters.q
        ? or(
            ilike(schema.organization.name, `%${filters.q.replace(/[%_]/g, '')}%`),
            ilike(schema.organization.slug, `%${filters.q.replace(/[%_]/g, '')}%`),
          )
        : undefined,
    );
    const [totalRow] = await tx
      .select({ n: count() })
      .from(schema.organization)
      .leftJoin(
        schema.organizationProfiles,
        eq(schema.organizationProfiles.organizationId, schema.organization.id),
      )
      .where(where);
    const rows = await tx
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        createdAt: schema.organization.createdAt,
        kind: schema.organizationProfiles.kind,
        ownershipType: schema.organizationProfiles.ownershipType,
        countryCode: schema.organizationProfiles.countryCode,
      })
      .from(schema.organization)
      .leftJoin(
        schema.organizationProfiles,
        eq(schema.organizationProfiles.organizationId, schema.organization.id),
      )
      .where(where)
      .orderBy(asc(schema.organization.name))
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);
    const ids = rows.map((r) => r.id);
    const members = ids.length
      ? await tx
          .select({ organizationId: schema.member.organizationId, n: count() })
          .from(schema.member)
          .where(inArray(schema.member.organizationId, ids))
          .groupBy(schema.member.organizationId)
      : [];
    const requests = ids.length
      ? await tx
          .select({
            organizationId: schema.serviceRequests.organizationId,
            n: count(),
            open: sql<number>`count(*) filter (where ${schema.serviceRequests.status} not in ('completed','rejected','cancelled'))`,
          })
          .from(schema.serviceRequests)
          .where(inArray(schema.serviceRequests.organizationId, ids))
          .groupBy(schema.serviceRequests.organizationId)
      : [];
    const memberMap = new Map(members.map((m) => [m.organizationId, Number(m.n)]));
    const requestMap = new Map(
      requests.map((r) => [r.organizationId, { n: Number(r.n), open: Number(r.open) }]),
    );
    return {
      total: Number(totalRow?.n ?? 0),
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        kind: r.kind ?? 'customer',
        ownershipType: r.ownershipType ?? null,
        countryCode: r.countryCode ?? null,
        memberCount: memberMap.get(r.id) ?? 0,
        requestCount: requestMap.get(r.id)?.n ?? 0,
        openRequestCount: requestMap.get(r.id)?.open ?? 0,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}

export interface CustomerMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  banned: boolean;
  countryOfResidence: string | null;
  createdAt: string;
}

export interface CustomerOrgView {
  organization: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    kind: string;
    legalName: string | null;
    ownershipType: string | null;
    countryCode: string | null;
    address: unknown;
    taxIdMasked: string | null;
    defaultTimeZone: string | null;
  };
  sensitiveVisible: boolean;
  members: CustomerMember[];
  invitations: Array<{ id: string; email: string; role: string; status: string; expiresAt: string }>;
  properties: PropertyDto[];
  projects: Array<{ id: string; name: string; status: string; kind: string; updatedAt: string }>;
  invoices: InvoiceDto[];
  conversations: Array<{
    id: string;
    kind: string;
    subject: string;
    closedAt: string | null;
    lastMessageAt: string | null;
  }>;
  permissions: { manage: boolean; finance: boolean; messages: boolean; support: boolean };
}

/** Organisation detail with masking for actors without `customers.read_sensitive`. */
export async function getCustomerOrganization(
  identity: RequestIdentity,
  organizationId: string,
): Promise<CustomerOrgView | null> {
  requireAnyStaff(identity, ['customers.read']);
  const sensitiveVisible = can(identity, 'customers.read_sensitive');
  const base = await staffTx(identity, async (tx) => {
    const [org] = await tx
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        createdAt: schema.organization.createdAt,
        kind: schema.organizationProfiles.kind,
        legalName: schema.organizationProfiles.legalName,
        ownershipType: schema.organizationProfiles.ownershipType,
        countryCode: schema.organizationProfiles.countryCode,
        address: schema.organizationProfiles.address,
        taxIdMasked: schema.organizationProfiles.taxIdMasked,
        defaultTimeZone: schema.organizationProfiles.defaultTimeZone,
      })
      .from(schema.organization)
      .leftJoin(
        schema.organizationProfiles,
        eq(schema.organizationProfiles.organizationId, schema.organization.id),
      )
      .where(eq(schema.organization.id, organizationId));
    if (!org) return null;
    const members = await tx
      .select({
        id: schema.member.id,
        userId: schema.member.userId,
        role: schema.member.role,
        createdAt: schema.member.createdAt,
        name: schema.user.name,
        email: schema.user.email,
        emailVerified: schema.user.emailVerified,
        twoFactorEnabled: schema.user.twoFactorEnabled,
        banned: schema.user.banned,
        phone: schema.userProfiles.phoneE164,
        countryOfResidence: schema.userProfiles.countryOfResidence,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.member.userId))
      .where(eq(schema.member.organizationId, organizationId))
      .orderBy(asc(schema.user.name));
    const invitations = await tx
      .select({
        id: schema.invitation.id,
        email: schema.invitation.email,
        role: schema.invitation.role,
        status: schema.invitation.status,
        expiresAt: schema.invitation.expiresAt,
      })
      .from(schema.invitation)
      .where(
        and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.status, 'pending')),
      )
      .orderBy(desc(schema.invitation.expiresAt));
    const projects = await tx
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        status: schema.projects.status,
        kind: schema.projects.kind,
        updatedAt: schema.projects.updatedAt,
      })
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, organizationId))
      .orderBy(desc(schema.projects.updatedAt))
      .limit(50);
    const conversations = await tx
      .select({
        id: schema.conversations.id,
        kind: schema.conversations.kind,
        subject: schema.conversations.subject,
        closedAt: schema.conversations.closedAt,
        lastMessageAt: schema.conversations.lastMessageAt,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.organizationId, organizationId))
      .orderBy(desc(schema.conversations.createdAt))
      .limit(50);
    return { org, members, invitations, projects, conversations };
  });
  if (!base) return null;
  const { rt, fa } = financeFor(identity);
  const [properties, invoices] = await Promise.all([
    listProperties(identity, { organizationId, status: 'active', limit: 50 }).then((p) => p.items),
    can(identity, 'finance.read')
      ? listInvoices(rt, fa, { organizationId, limit: 50 }).then((p) => p.items)
      : Promise.resolve([] as InvoiceDto[]),
  ]);
  return {
    organization: {
      id: base.org.id,
      name: base.org.name,
      slug: base.org.slug,
      createdAt: base.org.createdAt.toISOString(),
      kind: base.org.kind ?? 'customer',
      legalName: base.org.legalName ?? null,
      ownershipType: base.org.ownershipType ?? null,
      countryCode: base.org.countryCode ?? null,
      address: sensitiveVisible ? (base.org.address ?? null) : null,
      taxIdMasked: base.org.taxIdMasked ?? null,
      defaultTimeZone: base.org.defaultTimeZone ?? null,
    },
    sensitiveVisible,
    members: base.members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.name,
      email: sensitiveVisible ? m.email : maskEmail(m.email),
      phone: sensitiveVisible ? (m.phone ?? null) : maskPhone(m.phone ?? null),
      role: m.role,
      emailVerified: Boolean(m.emailVerified),
      twoFactorEnabled: Boolean(m.twoFactorEnabled),
      banned: Boolean(m.banned),
      countryOfResidence: m.countryOfResidence ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
    invitations: base.invitations.map((i) => ({
      id: i.id,
      email: sensitiveVisible ? i.email : maskEmail(i.email),
      role: i.role ?? 'member',
      status: i.status,
      expiresAt: i.expiresAt.toISOString(),
    })),
    properties,
    projects: base.projects.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() })),
    invoices,
    conversations: base.conversations.map((c) => ({
      id: c.id,
      kind: c.kind,
      subject: c.subject,
      closedAt: iso(c.closedAt),
      lastMessageAt: iso(c.lastMessageAt),
    })),
    permissions: {
      manage: can(identity, 'customers.manage'),
      finance: can(identity, 'finance.read'),
      messages: can(identity, 'messages.read_all'),
      support: can(identity, 'support.tickets.manage'),
    },
  };
}

/** Lightweight organisation picker options (name search) for forms. */
export async function searchOrganizations(
  identity: RequestIdentity,
  q: string | undefined,
  limit = 50,
): Promise<Array<{ id: string; name: string }>> {
  requireAnyStaff(identity, [
    'customers.read',
    'projects.read_all',
    'service_requests.read_all',
    'finance.read',
    'tenders.manage',
    'procurement.manage',
  ]);
  return staffTx(identity, (tx) =>
    tx
      .select({ id: schema.organization.id, name: schema.organization.name })
      .from(schema.organization)
      .leftJoin(
        schema.organizationProfiles,
        eq(schema.organizationProfiles.organizationId, schema.organization.id),
      )
      .where(
        and(
          or(isNull(schema.organizationProfiles.kind), eq(schema.organizationProfiles.kind, 'customer')),
          q ? ilike(schema.organization.name, `%${q.replace(/[%_]/g, '')}%`) : undefined,
        ),
      )
      .orderBy(asc(schema.organization.name))
      .limit(limit),
  );
}
