import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@simplexd/db';
import { chartOfAccounts, taxTreatmentDefaults } from '@simplexd/db/seed';
import { uniqueSuffix } from '@simplexd/db/testing';
import type { OrgRole, StaffRole } from '@simplexd/domain/authz';
import { DevPaymentProvider } from '@simplexd/integrations/payments';
import type { FinanceActor } from '../actor';
import { createFinanceRuntime, type FinanceRuntime } from '../runtime';

/**
 * Fixture builders for the finance integration suites. They insert rows
 * with the owner role (no row-level security) and build FinanceActor values
 * that mirror what the web layer derives from a session.
 */

export const TEST_APP_URL = 'http://localhost:3000';

export function customerActor(input: {
  userId: string;
  organizationId: string;
  role?: OrgRole;
  correlationId?: string;
}): FinanceActor {
  return {
    actor: {
      userId: input.userId,
      staffRoles: [],
      memberships: [{ organizationId: input.organizationId, role: input.role ?? 'owner' }],
      activeOrganizationId: input.organizationId,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags: {},
    },
    ctx: {
      userId: input.userId,
      organizationId: input.organizationId,
      staff: false,
      anonymousToken: null,
    },
    correlationId: input.correlationId ?? `corr-${uniqueSuffix()}`,
    ipHash: 'iphash-test',
    userAgent: 'vitest',
  };
}

export function staffActor(input: {
  userId: string;
  roles: StaffRole[];
  mfaVerified?: boolean;
  correlationId?: string;
}): FinanceActor {
  return {
    actor: {
      userId: input.userId,
      staffRoles: input.roles,
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: input.mfaVerified ?? true,
      impersonation: null,
      flags: {},
    },
    ctx: { userId: input.userId, organizationId: null, staff: true, anonymousToken: null },
    correlationId: input.correlationId ?? `corr-${uniqueSuffix()}`,
  };
}

export interface Tenants {
  sfx: string;
  userA: string;
  userB: string;
  opsUser: string;
  financeUser1: string;
  financeUser2: string;
  orgA: string;
  orgB: string;
  serviceId: string;
}

export async function seedTenants(owner: Database): Promise<Tenants> {
  const sfx = uniqueSuffix();
  const t: Tenants = {
    sfx,
    userA: `fin_user_a_${sfx}`,
    userB: `fin_user_b_${sfx}`,
    opsUser: `fin_ops_${sfx}`,
    financeUser1: `fin_fin1_${sfx}`,
    financeUser2: `fin_fin2_${sfx}`,
    orgA: `fin_org_a_${sfx}`,
    orgB: `fin_org_b_${sfx}`,
    serviceId: '',
  };
  await owner.insert(schema.user).values(
    [t.userA, t.userB, t.opsUser, t.financeUser1, t.financeUser2].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
  await owner.insert(schema.organization).values([
    { id: t.orgA, name: 'Org A', slug: t.orgA },
    { id: t.orgB, name: 'Org B', slug: t.orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${t.userA}`, organizationId: t.orgA, userId: t.userA, role: 'owner' },
    { id: `m_${t.userB}`, organizationId: t.orgB, userId: t.userB, role: 'owner' },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: t.opsUser, role: 'operations_manager' },
    { userId: t.financeUser1, role: 'finance' },
    { userId: t.financeUser2, role: 'finance' },
  ]);
  const [service] = await owner
    .insert(schema.services)
    .values({
      slug: `due-diligence-${sfx}`,
      name: 'Due diligence (finance test)',
      category: 'core',
      shortDescription: 'test',
      workflowTemplateKey: 'due_diligence',
      bookingEnabled: true,
      publicationState: 'published',
    })
    .returning({ id: schema.services.id });
  t.serviceId = service!.id;
  await owner
    .insert(schema.slaPolicies)
    .values({ serviceId: t.serviceId, stage: 'triage', targetHours: 24, businessHoursOnly: false });
  await owner
    .insert(schema.ledgerAccounts)
    .values(chartOfAccounts)
    .onConflictDoNothing({ target: schema.ledgerAccounts.code });
  for (const tt of taxTreatmentDefaults)
    await owner.insert(schema.taxTreatments).values(tt).onConflictDoNothing();
  return t;
}

export async function insertServiceRequest(
  owner: Database,
  t: Tenants,
  input: { organizationId: string; requestedByUserId: string; status?: 'inquiry' | 'triage' },
): Promise<{ id: string; reference: string }> {
  const reference = `SR-2026-${uniqueSuffix().slice(-6).toUpperCase()}`;
  const [row] = await owner
    .insert(schema.serviceRequests)
    .values({
      reference,
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      serviceId: t.serviceId,
      title: 'Diligence on Plot 12',
      description: 'Title check before purchase',
      status: input.status ?? 'inquiry',
    })
    .returning({ id: schema.serviceRequests.id, reference: schema.serviceRequests.reference });
  await owner.insert(schema.engagementTransitions).values({
    serviceRequestId: row!.id,
    fromStatus: null,
    toStatus: 'inquiry',
    actorUserId: input.requestedByUserId,
    actorType: 'customer',
  });
  return row!;
}

export function devProviderRuntime(db: Database): { rt: FinanceRuntime; dev: DevPaymentProvider } {
  const dev = new DevPaymentProvider({ appUrl: TEST_APP_URL, appEnv: 'test' });
  const rt = createFinanceRuntime({
    db,
    appUrl: TEST_APP_URL,
    appEnv: 'test',
    defaultEnvironment: 'test',
    resolveProvider: async (environment) =>
      environment === 'test'
        ? { kind: 'dev', environment: 'test', provider: dev, webhookSecretConfigured: true }
        : null,
  });
  return { rt, dev };
}

/** Debits must equal credits in every journal and across the ledger. */
export async function assertLedgerBalanced(
  owner: Database,
): Promise<{ debitKobo: bigint; creditKobo: bigint; unbalancedJournals: number }> {
  const totals = await owner.execute<{ d: string; c: string }>(
    sql`select coalesce(sum(debit_kobo),0)::text as d, coalesce(sum(credit_kobo),0)::text as c from journal_lines`,
  );
  const perJournal = await owner.execute<{ n: string }>(
    sql`select count(*)::text as n from (select journal_id, sum(debit_kobo) d, sum(credit_kobo) c from journal_lines group by journal_id) j where j.d <> j.c`,
  );
  return {
    debitKobo: BigInt(totals.rows[0]?.d ?? '0'),
    creditKobo: BigInt(totals.rows[0]?.c ?? '0'),
    unbalancedJournals: Number(perJournal.rows[0]?.n ?? '0'),
  };
}

export async function countAllocationsForAttempt(
  owner: Database,
  attemptId: string,
): Promise<number> {
  const rows = await owner
    .select({ id: schema.allocations.id })
    .from(schema.allocations)
    .where(eq(schema.allocations.paymentAttemptId, attemptId));
  return rows.length;
}

export async function countReceiptsForInvoice(owner: Database, invoiceId: string): Promise<number> {
  const rows = await owner
    .select({ id: schema.receipts.id })
    .from(schema.receipts)
    .where(eq(schema.receipts.invoiceId, invoiceId));
  return rows.length;
}

export async function journalByRef(owner: Database, ref: string) {
  const [row] = await owner
    .select()
    .from(schema.journals)
    .where(eq(schema.journals.businessEventRef, ref));
  return row ?? null;
}
