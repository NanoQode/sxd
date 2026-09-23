import 'server-only';
import { getPaymentAttempt } from '@simplexd/finance';
import { getFinanceRuntime } from '@/server/finance/runtime';
import { cache } from 'react';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type {
  LeaseBalanceDto,
  LeasePartyDto,
  RentChargeDto,
  RentScheduleDto,
  TenantLeaseSummary,
  TenantNoticeDto,
  TenantReceiptDto,
  WorkOrderDto,
} from '@simplexd/contracts';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import type { TenantAppointment, TenantInvoice } from '@/lib/tenant/model';
import { getFile } from '@/server/files/queries';
import { getWorkOrder } from '@/server/maintenance/work-orders';
import { listParties } from '@/server/rentals/leases';
import { listSchedule } from '@/server/rentals/schedules';
import {
  getMyBalance,
  getMyLease,
  listMyAppointments,
  listMyCharges,
  listMyLeases,
  listMyNotices,
  listMyReceipts,
  listMyTickets,
} from '@/server/rentals/tenant';
import { safeLoad, type Loaded } from './load';

/**
 * Read models for the tenant screens. Every read goes through the tenant
 * services (`server/rentals/tenant`), which start from the caller's own
 * active lease parties; the few extra reads here are narrowed the same way
 * (the caller's own party record, invoices where the caller is the invoiced
 * customer on their own lease, files the file policy lets them see). No
 * owner ledger, portfolio or other tenant's record is ever requested.
 */

export function userIdOf(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

export function zoneOf(identity: RequestIdentity): string {
  return identity.profile?.timeZone ?? 'Africa/Lagos';
}

/** Cached per request: the layout and the page share one read (identity is per-request too). */
export const loadMyLeases = cache(
  (identity: RequestIdentity): Promise<Loaded<TenantLeaseSummary[]>> =>
    safeLoad('your leases', () => listMyLeases(identity)),
);

export function loadLease(
  identity: RequestIdentity,
  leaseId: string,
): Promise<Loaded<TenantLeaseSummary>> {
  return safeLoad('this lease', () => getMyLease(identity, leaseId));
}

export function loadBalance(
  identity: RequestIdentity,
  leaseId: string,
): Promise<Loaded<LeaseBalanceDto>> {
  return safeLoad('your balance', () => getMyBalance(identity, leaseId));
}

export function loadCharges(
  identity: RequestIdentity,
  leaseId: string,
): Promise<Loaded<RentChargeDto[]>> {
  return safeLoad('your charges', () => listMyCharges(identity, leaseId));
}

/** The rent schedule of a lease already confirmed as the caller's (tenant.balances.view). */
export function loadSchedule(
  identity: RequestIdentity,
  leaseId: string,
): Promise<Loaded<RentScheduleDto[]>> {
  return safeLoad('the rent schedule', () => listSchedule(identity, leaseId));
}

/** Only the caller's own party record, even when the caller could see more in another role. */
export function loadMyParty(
  identity: RequestIdentity,
  leaseId: string,
): Promise<Loaded<LeasePartyDto | null>> {
  const userId = userIdOf(identity);
  return safeLoad('your party record', async () => {
    const parties = await listParties(identity, leaseId);
    return parties.find((p) => p.userId === userId) ?? null;
  });
}

export function loadReceipts(identity: RequestIdentity): Promise<Loaded<TenantReceiptDto[]>> {
  return safeLoad('your receipts', () => listMyReceipts(identity));
}

export const loadNotices = cache((identity: RequestIdentity): Promise<Loaded<TenantNoticeDto[]>> =>
  safeLoad('your notices', () => listMyNotices(identity)),
);

export function loadTickets(identity: RequestIdentity): Promise<Loaded<WorkOrderDto[]>> {
  return safeLoad('your maintenance tickets', async () =>
    (await listMyTickets(identity)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export function loadAppointments(identity: RequestIdentity): Promise<Loaded<TenantAppointment[]>> {
  return safeLoad('your appointments', () => listMyAppointments(identity));
}

/**
 * One ticket, shown only when the caller reported it on one of their own
 * leases (the same rule as the ticket list). Anything else answers not
 * found, even if the caller could open it in another role.
 */
export function loadTicket(
  identity: RequestIdentity,
  ticketId: string,
  myLeaseIds: string[],
): Promise<Loaded<WorkOrderDto>> {
  const userId = userIdOf(identity);
  return safeLoad('this ticket', async () => {
    const ticket = await getWorkOrder(identity, ticketId);
    if (
      ticket.reportedByUserId !== userId ||
      !ticket.leaseId ||
      !myLeaseIds.includes(ticket.leaseId)
    )
      throw new ApiError('not_found', 'ticket not found');
    return ticket;
  });
}

/**
 * Invoices raised to the caller for their own leases. Row-level security
 * lets an invoiced customer read their invoice row; the filter keeps the
 * result to the caller's active leases, mirroring the receipts service.
 */
export function loadMyInvoices(
  identity: RequestIdentity,
  leaseIds: string[],
): Promise<Loaded<TenantInvoice[]>> {
  const userId = userIdOf(identity);
  return safeLoad('your invoices', async () => {
    if (leaseIds.length === 0) return [];
    const rows = await withActor(getDb(), identity.ctx, async (tx) =>
      tx
        .select({
          id: schema.invoices.id,
          number: schema.invoices.number,
          status: schema.invoices.status,
          leaseId: schema.invoices.leaseId,
          currency: schema.invoices.currency,
          totalKobo: schema.invoices.totalKobo,
          amountPaidKobo: schema.invoices.amountPaidKobo,
          amountCreditedKobo: schema.invoices.amountCreditedKobo,
          dueDate: schema.invoices.dueDate,
          issuedAt: schema.invoices.issuedAt,
        })
        .from(schema.invoices)
        .where(
          and(
            inArray(schema.invoices.leaseId, leaseIds),
            eq(schema.invoices.customerUserId, userId),
            ne(schema.invoices.status, 'draft'),
          ),
        )
        .orderBy(desc(schema.invoices.dueDate), desc(schema.invoices.createdAt))
        .limit(200),
    );
    return rows.map((r) => {
      const balance = r.totalKobo - r.amountPaidKobo - r.amountCreditedKobo;
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        leaseId: r.leaseId,
        currency: r.currency,
        totalKobo: r.totalKobo.toString(),
        balanceKobo: (balance > 0n ? balance : 0n).toString(),
        dueDate: r.dueDate,
        issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
      };
    });
  });
}

/**
 * Whether the finance API would accept a payment attempt from this caller
 * for invoices of the lease's organisation. It mirrors the check in
 * `createPaymentAttempt` (`org.invoices.pay` on the invoice organisation,
 * which for rent is the owner): a tenant who is not a member of the owner
 * organisation cannot pay online, so no Pay control is rendered for them.
 */
export interface PaymentResult {
  tone: 'success' | 'warning' | 'danger' | 'info';
  title: string;
  message: string;
}

/**
 * The server-verified state of a payment attempt the caller started, shown
 * after returning from checkout. The query string only names the attempt;
 * the outcome always comes from the stored, provider-verified status.
 */
export async function loadPaymentResult(
  identity: RequestIdentity,
  attemptId: string,
): Promise<PaymentResult | null> {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return null;
  try {
    const rt = getFinanceRuntime();
    const attempt = await getPaymentAttempt(
      rt,
      { actor: identity.actor, ctx: identity.ctx },
      attemptId,
    );
    switch (attempt.status) {
      case 'successful':
        return {
          tone: 'success',
          title: 'Payment received',
          message:
            'The payment was verified with the payment provider. Your receipt is on the Receipts page.',
        };
      case 'failed':
      case 'abandoned':
        return {
          tone: 'danger',
          title: 'Payment not completed',
          message: 'No money was taken. You can try again from the invoice below.',
        };
      case 'uncertain':
      case 'reversed':
        return {
          tone: 'warning',
          title: 'Payment needs checking',
          message:
            'The provider reported something that does not match this invoice, so it has not been applied. SimplexD finance will review it; contact support if you were charged.',
        };
      default:
        return {
          tone: 'info',
          title: 'Payment pending',
          message:
            'The provider has not confirmed the payment yet. This page updates once it is verified; do not pay again in the meantime.',
        };
    }
  } catch {
    return null;
  }
}

export interface VisibleFile {
  id: string;
  name: string;
  status: string;
}

/**
 * Files the caller may open, decided by the file policy itself (owner,
 * membership, explicit grant). Files the caller cannot see are counted, not
 * named, so the page can say they exist without leaking anything else.
 */
export async function visibleFiles(
  identity: RequestIdentity,
  fileIds: string[],
): Promise<{ visible: VisibleFile[]; hidden: number }> {
  const unique = [...new Set(fileIds)];
  const results = await Promise.all(
    unique.map(async (id): Promise<VisibleFile | null> => {
      try {
        const file = await getFile(identity, id);
        return { id: file.id, name: file.originalName, status: file.status };
      } catch {
        return null;
      }
    }),
  );
  const visible = results.filter((r): r is VisibleFile => r !== null);
  return { visible, hidden: unique.length - visible.length };
}
