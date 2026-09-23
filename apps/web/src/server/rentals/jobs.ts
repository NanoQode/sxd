import 'server-only';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { ApiError, type RentInvoicingRunDto } from '@simplexd/contracts';
import { schema, systemContext, withActor, type Database } from '@simplexd/db';
import { periodsDueForInvoicing } from '@simplexd/domain/rentals';
import { logger } from '@/lib/logger';
import { advanceLeaseLifecycle, expireInvitations } from './leases';
import {
  DEFAULT_INVOICE_LEAD_DAYS,
  invoiceDepositTx,
  invoiceScheduleTx,
  syncRentAllocations,
} from './schedules';
import { systemActorFor, today } from './shared';

/**
 * The rent job (`rent.generate_due_charges`, hourly in the worker; staff can
 * run it on demand through `POST /api/v1/rent/invoicing-runs`). Each lease is
 * processed in its own transaction under the system context, serialised by
 * an advisory lock on the lease, so one failing lease never holds back the
 * others and a re-run is always safe:
 *
 *  1. active or expiring leases: the deposit invoice once, then one `rent`
 *     invoice per period due within the lead window (collected on the
 *     owner's behalf, estate segment when the property is in an estate);
 *  2. settled money on the lease's invoices is mirrored into
 *     `rent_allocations`, schedule statuses refreshed and a `rent.overdue`
 *     late notice emitted the first time a period turns overdue (leases that
 *     ended with periods still open keep being reconciled);
 *  3. the system lifecycle step (`expiring` inside the notice window,
 *     `ended` after the end date);
 *  4. finally, lapsed tenant invitations are marked expired.
 *
 * The worker handler (apps/worker/src/handlers/rentals.ts) runs the same
 * steps with the same domain functions.
 */

export interface RentJobOptions {
  asOf?: string;
  leadDays?: number;
  now?: Date;
  correlationId?: string;
  leaseIds?: string[];
}

export async function runRentInvoicing(
  db: Database,
  options: RentJobOptions = {},
): Promise<RentInvoicingRunDto> {
  const now = options.now ?? new Date();
  const asOf = options.asOf ?? today(now);
  const leadDays = options.leadDays ?? DEFAULT_INVOICE_LEAD_DAYS;
  const correlationId = options.correlationId ?? `rent-job:${asOf}`;
  const ctx = systemContext(correlationId);
  const fa = systemActorFor(null, correlationId);
  const run: RentInvoicingRunDto = {
    leases: 0,
    invoiced: 0,
    skipped: 0,
    invoiceIds: [],
    overdue: 0,
    transitions: [],
    expiredInvitations: 0,
    failures: [],
  };
  const leaseIds = await withActor(db, ctx, async (tx) =>
    (
      await tx
        .select({ id: schema.leases.id })
        .from(schema.leases)
        .where(
          and(
            or(
              inArray(schema.leases.status, ['active', 'expiring']),
              sql`exists (select 1 from rent_schedules rs where rs.lease_id = ${schema.leases.id}
                    and rs.status in ('invoiced', 'partially_paid', 'overdue'))`,
            ),
            options.leaseIds ? inArray(schema.leases.id, options.leaseIds) : undefined,
          ),
        )
        .orderBy(asc(schema.leases.createdAt), asc(schema.leases.id))
    ).map((r) => r.id),
  );

  for (const leaseId of leaseIds) {
    try {
      const step = await withActor(db, ctx, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lease:${leaseId}`}))`);
        const [lease] = await tx.select().from(schema.leases).where(eq(schema.leases.id, leaseId));
        if (!lease) return null;
        const invoiceIds: string[] = [];
        let skipped = 0;
        if (lease.status === 'active' || lease.status === 'expiring') {
          const deposit = await invoiceDepositTx(tx, fa, lease, now);
          if (deposit) invoiceIds.push(deposit);
          const schedules = await tx
            .select()
            .from(schema.rentSchedules)
            .where(eq(schema.rentSchedules.leaseId, lease.id))
            .orderBy(asc(schema.rentSchedules.dueDate));
          for (const s of periodsDueForInvoicing(schedules, asOf, leadDays)) {
            const id = await invoiceScheduleTx(tx, fa, s, lease, now);
            if (id) invoiceIds.push(id);
            else skipped += 1;
          }
        }
        const { overdue } = await syncRentAllocations(tx, [lease.id], asOf);
        const transition = await advanceLeaseLifecycle(tx, lease, asOf, correlationId);
        return { invoiceIds, skipped, overdue, transition };
      });
      if (!step) continue;
      run.leases += 1;
      run.invoiced += step.invoiceIds.length;
      run.invoiceIds.push(...step.invoiceIds);
      run.skipped += step.skipped;
      run.overdue += step.overdue;
      if (step.transition === 'expiring' || step.transition === 'ended')
        run.transitions.push({ leaseId, to: step.transition });
    } catch (err) {
      logger().error({ err, leaseId, correlationId }, 'rent job step failed for a lease');
      run.failures.push({
        leaseId,
        message: err instanceof ApiError ? err.message : 'internal error; see the job log',
      });
    }
  }

  run.expiredInvitations = await withActor(db, ctx, (tx) => expireInvitations(tx, now));
  return run;
}
