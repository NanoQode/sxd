import 'server-only';
import { inArray } from 'drizzle-orm';
import {
  ApiError,
  type LeaseBalanceDto,
  type LeaseDto,
  type OwnerStatementDto,
  type WorkOrderDto,
} from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { listWorkOrders } from '@/server/maintenance/work-orders';
import { listLeases } from '@/server/rentals/leases';
import { getLeaseBalance } from '@/server/rentals/schedules';
import { getOwnerStatement, listOwnerStatements } from '@/server/rentals/owner-statements';

/**
 * Owner-side rental read models for portal pages: leases with balances,
 * maintenance work orders and owner statements. Permissions and row-level
 * security are enforced by the rental services; this module only combines
 * their results and turns "not yours" into null for notFound().
 */

export interface LeaseWithBalance {
  lease: LeaseDto;
  /** Null when the balance could not be computed (the page says so instead of showing zero). */
  balance: LeaseBalanceDto | null;
}

const BALANCE_STATUSES = new Set(['active', 'expiring', 'ended', 'terminated']);

export async function loadPropertyLeases(
  identity: RequestIdentity,
  propertyId: string,
): Promise<LeaseWithBalance[]> {
  const page = await listLeases(identity, { propertyId, limit: 50 });
  return Promise.all(
    page.items.map(async (lease) => ({
      lease,
      balance: BALANCE_STATUSES.has(lease.status)
        ? await getLeaseBalance(identity, lease.id).catch(() => null)
        : null,
    })),
  );
}

export async function loadPropertyWorkOrders(
  identity: RequestIdentity,
  propertyId: string,
): Promise<WorkOrderDto[]> {
  const page = await listWorkOrders(identity, { propertyId, limit: 100 });
  return page.items;
}

export async function loadOwnerStatements(
  identity: RequestIdentity,
  options: { propertyId?: string; cursor?: string } = {},
): Promise<{ items: OwnerStatementDto[]; nextCursor: string | null }> {
  return listOwnerStatements(identity, {
    limit: 50,
    ...(options.propertyId ? { propertyId: options.propertyId } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
}

export async function loadOwnerStatement(
  identity: RequestIdentity,
  id: string,
): Promise<OwnerStatementDto | null> {
  return getOwnerStatement(identity, id).catch((err: unknown) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
      return null;
    throw err;
  });
}

/** Property names for labels, scoped by row-level security to what the caller may read. */
export async function propertyNames(
  identity: RequestIdentity,
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0 || !identity.session) return new Map();
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ id: schema.properties.id, name: schema.properties.name })
      .from(schema.properties)
      .where(inArray(schema.properties.id, unique)),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}
