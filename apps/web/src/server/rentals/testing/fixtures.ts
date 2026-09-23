import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@simplexd/db';
import { chartOfAccounts, taxTreatmentDefaults } from '@simplexd/db/seed';
import {
  connectTestDatabases,
  resetDatabase,
  uniqueSuffix,
  type TestDatabases,
} from '@simplexd/db/testing';
import { createFinanceRuntime, settleAttempt, type FinanceRuntime } from '@simplexd/finance';
import type { OrgRole, StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { FEATURES } from '../shared';

/**
 * Integration fixtures for property management: two owner organisations
 * with a property and unit each, staff (operations, two finance approvers,
 * support), a contractor partner and two tenant users. Rows are inserted
 * with the owner role; services under test run through the runtime role.
 */

export interface RentalFixture {
  dbs: TestDatabases;
  rt: FinanceRuntime;
  orgA: string;
  orgB: string;
  ownerA: string;
  ownerB: string;
  adviserA: string;
  ops: string;
  finance1: string;
  finance2: string;
  support: string;
  partner: string;
  tenant1: string;
  tenant2: string;
  propertyA: string;
  unitA1: string;
  propertyB: string;
  unitB1: string;
}

export interface IdentityOptions {
  staffRoles?: StaffRole[];
  memberships?: Array<{ organizationId: string; role: OrgRole }>;
  activeOrganizationId?: string | null;
  isPartner?: boolean;
  mfaVerified?: boolean;
  flags?: Record<string, boolean>;
  email?: string;
}

export function identityFor(userId: string, opts: IdentityOptions = {}): RequestIdentity {
  const memberships = opts.memberships ?? [];
  const activeOrganizationId =
    opts.activeOrganizationId === undefined
      ? (memberships[0]?.organizationId ?? null)
      : opts.activeOrganizationId;
  const staffRoles = opts.staffRoles ?? [];
  const now = new Date();
  const flags = opts.flags ?? {};
  const session = {
    user: {
      id: userId,
      name: userId,
      email: opts.email ?? `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `sess_${userId}`,
      userId,
      token: `tok_${userId}`,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      activeOrganizationId,
    },
  } as unknown as RequestIdentity['session'];
  return {
    session,
    actor: {
      userId,
      staffRoles,
      memberships,
      activeOrganizationId,
      isPartner: opts.isPartner ?? false,
      mfaVerified: opts.mfaVerified ?? false,
      impersonation: null,
      flags,
    },
    ctx: { userId, organizationId: activeOrganizationId, staff: staffRoles.length > 0 },
    profile: null,
    featureFlags: flags,
  };
}

export const ALL_FLAGS: Record<string, boolean> = Object.fromEntries(
  Object.values(FEATURES).map((k) => [k, true]),
);

export async function createRentalFixture(): Promise<RentalFixture> {
  const dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  const owner = dbs.owner;
  const s = uniqueSuffix();
  const ids = {
    orgA: `org_a_${s}`,
    orgB: `org_b_${s}`,
    ownerA: `owner_a_${s}`,
    ownerB: `owner_b_${s}`,
    adviserA: `adviser_a_${s}`,
    ops: `ops_${s}`,
    finance1: `fin1_${s}`,
    finance2: `fin2_${s}`,
    support: `support_${s}`,
    partner: `partner_${s}`,
    tenant1: `tenant1_${s}`,
    tenant2: `tenant2_${s}`,
  };
  await owner.insert(schema.user).values(
    Object.entries(ids)
      .filter(([k]) => !k.startsWith('org'))
      .map(([, id]) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })),
  );
  await owner.insert(schema.organization).values([
    { id: ids.orgA, name: 'Owner A', slug: ids.orgA },
    { id: ids.orgB, name: 'Owner B', slug: ids.orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${ids.ownerA}`, organizationId: ids.orgA, userId: ids.ownerA, role: 'owner' },
    { id: `m_${ids.adviserA}`, organizationId: ids.orgA, userId: ids.adviserA, role: 'adviser' },
    { id: `m_${ids.ownerB}`, organizationId: ids.orgB, userId: ids.ownerB, role: 'owner' },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: ids.ops, role: 'operations_manager' },
    { userId: ids.finance1, role: 'finance' },
    { userId: ids.finance2, role: 'finance' },
    { userId: ids.support, role: 'support' },
  ]);
  await owner.insert(schema.partnerProfiles).values({
    userId: ids.partner,
    partnerType: 'contractor',
    displayName: 'Fix-It Ltd',
    verificationStatus: 'verified',
  });
  await owner
    .insert(schema.ledgerAccounts)
    .values(chartOfAccounts)
    .onConflictDoNothing({ target: schema.ledgerAccounts.code });
  for (const tt of taxTreatmentDefaults)
    await owner.insert(schema.taxTreatments).values(tt).onConflictDoNothing();
  const [propertyA] = await owner
    .insert(schema.properties)
    .values({
      organizationId: ids.orgA,
      name: 'Lekki Court',
      kind: 'residential',
      address: { city: 'Lagos' },
    })
    .returning({ id: schema.properties.id });
  const [unitA1] = await owner
    .insert(schema.units)
    .values({ propertyId: propertyA!.id, label: 'A1', unitType: 'flat' })
    .returning({ id: schema.units.id });
  const [propertyB] = await owner
    .insert(schema.properties)
    .values({ organizationId: ids.orgB, name: 'Ikeja Heights', kind: 'residential' })
    .returning({ id: schema.properties.id });
  const [unitB1] = await owner
    .insert(schema.units)
    .values({ propertyId: propertyB!.id, label: 'B1', unitType: 'flat' })
    .returning({ id: schema.units.id });
  const rt = createFinanceRuntime({
    db: dbs.app,
    appUrl: 'http://localhost:3000',
    appEnv: 'test',
    defaultEnvironment: 'test',
    resolveProvider: async () => null,
  });
  return {
    dbs,
    rt,
    ...ids,
    propertyA: propertyA!.id,
    unitA1: unitA1!.id,
    propertyB: propertyB!.id,
    unitB1: unitB1!.id,
  };
}

export async function enableFlags(
  owner: Database,
  keys: string[] = Object.values(FEATURES),
): Promise<void> {
  for (const key of keys) {
    await owner
      .insert(schema.featureFlags)
      .values({ key, name: key, category: 'expansion', enabled: true })
      .onConflictDoUpdate({ target: schema.featureFlags.key, set: { enabled: true } });
  }
}

export function ownerIdentity(
  f: RentalFixture,
  which: 'A' | 'B',
  flags: Record<string, boolean> = {},
): RequestIdentity {
  return which === 'A'
    ? identityFor(f.ownerA, { memberships: [{ organizationId: f.orgA, role: 'owner' }], flags })
    : identityFor(f.ownerB, { memberships: [{ organizationId: f.orgB, role: 'owner' }], flags });
}

export function adviserIdentity(f: RentalFixture): RequestIdentity {
  return identityFor(f.adviserA, { memberships: [{ organizationId: f.orgA, role: 'adviser' }] });
}

export function opsIdentity(
  f: RentalFixture,
  flags: Record<string, boolean> = {},
): RequestIdentity {
  return identityFor(f.ops, { staffRoles: ['operations_manager'], flags });
}

export function financeIdentity(
  f: RentalFixture,
  which: 1 | 2,
  mfaVerified = true,
): RequestIdentity {
  return identityFor(which === 1 ? f.finance1 : f.finance2, {
    staffRoles: ['finance'],
    mfaVerified,
  });
}

export function supportIdentity(f: RentalFixture): RequestIdentity {
  return identityFor(f.support, { staffRoles: ['support'] });
}

export function partnerIdentity(f: RentalFixture): RequestIdentity {
  return identityFor(f.partner, { isPartner: true });
}

export function tenantIdentity(f: RentalFixture, which: 1 | 2): RequestIdentity {
  return identityFor(which === 1 ? f.tenant1 : f.tenant2);
}

/** A clean file in an organisation's store (owner role). */
export async function insertFile(
  owner: Database,
  organizationId: string,
  ownerUserId: string,
  mime = 'image/jpeg',
): Promise<string> {
  const [row] = await owner
    .insert(schema.fileObjects)
    .values({
      organizationId,
      ownerUserId,
      bucket: 'private',
      storageKey: `test/${uniqueSuffix()}`,
      originalName: 'evidence.jpg',
      declaredMime: mime,
      status: 'clean',
      purpose: 'evidence',
      checksumSha256: 'ab'.repeat(32),
    })
    .returning({ id: schema.fileObjects.id });
  return row!.id;
}

/**
 * Pays an issued invoice through the real settlement path: a pending
 * development-adapter attempt is inserted, then `settleAttempt` verifies the
 * simulated provider truth, posts the journal, allocates once and issues the
 * receipt.
 */
export async function payInvoice(
  f: RentalFixture,
  invoiceId: string,
  payerUserId: string,
  amountKobo?: bigint,
): Promise<{ attemptId: string; allocationId: string | null; receiptNumber: string | null }> {
  const [invoice] = await f.dbs.owner
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  if (!invoice) throw new Error('invoice not found');
  const amount =
    amountKobo ?? invoice.totalKobo - invoice.amountPaidKobo - invoice.amountCreditedKobo;
  const reference = `SXD-${uniqueSuffix().toUpperCase()}`;
  const [attempt] = await f.dbs.owner
    .insert(schema.paymentAttempts)
    .values({
      organizationId: invoice.organizationId,
      invoiceId,
      provider: 'dev',
      environment: 'test',
      reference,
      amountKobo: amount,
      currency: invoice.currency,
      status: 'pending',
      initiatedByUserId: payerUserId,
    })
    .returning({ id: schema.paymentAttempts.id });
  const result = await settleAttempt(f.rt, {
    attemptId: attempt!.id,
    verification: {
      providerStatus: 'success',
      amountKobo: amount,
      currency: invoice.currency,
      providerReference: reference,
      providerTransactionId: '1',
      paidAt: new Date().toISOString(),
      channel: 'card',
      feesKobo: null,
      gatewayResponse: 'Approved',
      environment: 'test',
      raw: {},
    },
    source: 'verify',
    actorUserId: payerUserId,
  });
  return {
    attemptId: attempt!.id,
    allocationId: result.allocationId,
    receiptNumber: result.receiptNumber,
  };
}

export async function ledgerBalanced(
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

export async function journalLinesByRef(
  owner: Database,
  ref: string,
): Promise<Array<{ code: string; debitKobo: bigint; creditKobo: bigint }>> {
  const rows = await owner.execute<{ code: string; d: string; c: string }>(sql`
    select la.code, jl.debit_kobo::text as d, jl.credit_kobo::text as c
    from journals j join journal_lines jl on jl.journal_id = j.id join ledger_accounts la on la.id = jl.account_id
    where j.business_event_ref = ${ref} order by jl.line_no`);
  return rows.rows.map((r) => ({ code: r.code, debitKobo: BigInt(r.d), creditKobo: BigInt(r.c) }));
}

/** Matches an ApiError or AuthorizationError by code. */
export function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; name?: string };
  if (e?.name === 'AuthorizationError') return 'forbidden';
  return e?.code;
}
