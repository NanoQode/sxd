import 'server-only';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiError,
  leaseTermsSchema,
  type LeaseDto,
  type LeasePartyDto,
  type LeaseTermsDto,
} from '@simplexd/contracts';
import {
  applyActorContext,
  schema,
  systemContext,
  type ActorContext,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import type { FinanceActor } from '@simplexd/finance';
import {
  assertAllowed,
  authorizeAny,
  authorizeTenant,
  type ResourceRef,
  type TenantPermission,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';

/**
 * Shared plumbing for property management: feature keys, actor contexts,
 * lease access resolution and DTO mappers. Every service runs inside
 * `withActor`, so row-level security (`app.can_access_lease`) is the second
 * net behind the explicit policy checks here: a lease of another
 * organisation is simply not visible and ends as `not_found`.
 */

/** Feature flags, keyed as the seed keys them (`expansion.<workflowTemplateKey>`). */
export const FEATURES = {
  preventiveMaintenance: 'expansion.preventive_maintenance',
  estateManagement: 'expansion.estate_management',
  rentalPlacement: 'expansion.rental_placement',
  studentHousing: 'expansion.student_housing',
  shortStay: 'expansion.short_stay',
} as const;

export function requireFlag(identity: RequestIdentity, key: string): void {
  requireFeature(identity, key);
}

export interface ServiceOptions {
  correlationId?: string;
}

export type LeaseRow = typeof schema.leases.$inferSelect;
export type LeasePartyRow = typeof schema.leaseParties.$inferSelect;

export function requireUserId(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

export function ctxFor(identity: RequestIdentity, options: ServiceOptions = {}): ActorContext {
  return options.correlationId
    ? { ...identity.ctx, correlationId: options.correlationId }
    : identity.ctx;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const kobo = (v: bigint | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function versionConflict(current?: number): ApiError {
  return new ApiError(
    'version_conflict',
    'this record changed since you loaded it; reload and try again',
    current === undefined ? {} : { details: { currentVersion: current } },
  );
}

/** Runs `fn` with the transaction elevated to bypass, then restores the caller's context. */
export async function elevated<T>(
  tx: Transaction,
  ctx: ActorContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (ctx.bypass) return fn();
  await applyActorContext(tx, { ...ctx, bypass: true });
  await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
  // On failure the transaction is aborted and rolled back by the caller; only a
  // successful elevation restores the caller's own context.
  const result = await fn();
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await applyActorContext(tx, { ...ctx, bypass: false });
  return result;
}

/** A finance actor for postings made by the platform on the caller's behalf (journals are privileged). */
export function systemActorFor(
  identity: RequestIdentity | null,
  correlationId?: string,
): FinanceActor {
  const userId = identity?.session?.user.id ?? null;
  return {
    actor: {
      userId,
      staffRoles: [],
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags: {},
    },
    ctx: systemContext(correlationId),
    ...(correlationId ? { correlationId } : {}),
  };
}

/* ---------------------------------------------------------------------- */
/* Lease access                                                            */
/* ---------------------------------------------------------------------- */

export function leaseRef(row: LeaseRow, partyUserIds: string[] = []): ResourceRef {
  return {
    type: 'lease',
    id: row.id,
    organizationId: row.organizationId,
    assigneeUserIds: partyUserIds,
  };
}

export async function loadLease(tx: DbExecutor, id: string): Promise<LeaseRow | null> {
  const rows = await tx.select().from(schema.leases).where(eq(schema.leases.id, id));
  return rows[0] ?? null;
}

export async function loadParties(tx: DbExecutor, leaseId: string): Promise<LeasePartyRow[]> {
  return tx
    .select()
    .from(schema.leaseParties)
    .where(eq(schema.leaseParties.leaseId, leaseId))
    .orderBy(asc(schema.leaseParties.createdAt), asc(schema.leaseParties.id));
}

export function activePartyUserIds(parties: LeasePartyRow[]): string[] {
  return parties
    .filter((p) => p.accessStatus === 'active' && p.userId)
    .map((p) => p.userId!) as string[];
}

export function assertLeaseManage(identity: RequestIdentity, ref: ResourceRef): void {
  assertAllowed(
    authorizeAny(identity.actor, [{ staff: 'rentals.manage' }, { org: 'org.leases.manage' }], ref),
  );
}

/** Staff, owner organisation members or an active tenant party may read a lease. */
export function assertLeaseRead(
  identity: RequestIdentity,
  ref: ResourceRef,
  tenantPermission: TenantPermission = 'tenant.lease.view',
): 'staff' | 'customer' | 'tenant' {
  const userId = requireUserId(identity);
  if (ref.assigneeUserIds?.includes(userId) && !isStaffIdentity(identity)) {
    assertAllowed(authorizeTenant(identity.actor, tenantPermission, ref));
    return 'tenant';
  }
  const decision = authorizeAny(
    identity.actor,
    [
      { staff: 'rentals.manage' },
      { staff: 'customers.read' },
      { staff: 'finance.read' },
      { org: 'org.read' },
    ],
    ref,
  );
  assertAllowed(decision);
  return decision.via.startsWith('staff') ? 'staff' : 'customer';
}

export interface LeaseAccess {
  lease: LeaseRow;
  parties: LeasePartyRow[];
  ref: ResourceRef;
  viewer: 'staff' | 'customer' | 'tenant';
}

/** Loads a lease the caller may read (`read`) or manage (`manage`); SQL visibility first, then policy. */
export async function requireLease(
  tx: DbExecutor,
  identity: RequestIdentity,
  id: string,
  mode: 'read' | 'manage',
  tenantPermission?: TenantPermission,
): Promise<LeaseAccess> {
  const lease = await loadLease(tx, id);
  if (!lease) throw new ApiError('not_found', 'lease not found');
  const parties = await loadParties(tx, id);
  const ref = leaseRef(lease, activePartyUserIds(parties));
  if (mode === 'manage') {
    assertLeaseManage(identity, ref);
    return { lease, parties, ref, viewer: isStaffIdentity(identity) ? 'staff' : 'customer' };
  }
  const viewer = assertLeaseRead(identity, ref, tenantPermission);
  return { lease, parties, ref, viewer };
}

/* ---------------------------------------------------------------------- */
/* Extended terms (notes row `lease_terms`)                                */
/* ---------------------------------------------------------------------- */

/**
 * Service charge, due-date lead, proration flag, academic terms, guarantor
 * and move-in inventory live in a structured `notes` row (`entity_type =
 * 'lease_terms'`, JSON body, visibility `customer`) until the schema gains
 * a `terms` column on `leases`. Only one such row exists per lease.
 */
export const LEASE_TERMS_ENTITY = 'lease_terms';

export async function loadLeaseTerms(
  tx: DbExecutor,
  leaseId: string,
): Promise<Partial<LeaseTermsDto> | null> {
  const [row] = await tx
    .select({ body: schema.notes.body })
    .from(schema.notes)
    .where(and(eq(schema.notes.entityType, LEASE_TERMS_ENTITY), eq(schema.notes.entityId, leaseId)))
    .limit(1);
  if (!row) return null;
  try {
    return leaseTermsSchema.partial().parse(JSON.parse(row.body));
  } catch {
    return null;
  }
}

export async function saveLeaseTerms(
  tx: DbExecutor,
  input: {
    leaseId: string;
    organizationId: string;
    authorUserId: string;
    terms: Partial<LeaseTermsDto>;
  },
): Promise<void> {
  const body = JSON.stringify(input.terms);
  const [existing] = await tx
    .select({ id: schema.notes.id })
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.entityType, LEASE_TERMS_ENTITY),
        eq(schema.notes.entityId, input.leaseId),
      ),
    )
    .limit(1);
  if (existing) {
    await tx.update(schema.notes).set({ body }).where(eq(schema.notes.id, existing.id));
    return;
  }
  await tx.insert(schema.notes).values({
    organizationId: input.organizationId,
    entityType: LEASE_TERMS_ENTITY,
    entityId: input.leaseId,
    body,
    visibility: 'customer',
    authorUserId: input.authorUserId,
  });
}

/* ---------------------------------------------------------------------- */
/* DTOs                                                                    */
/* ---------------------------------------------------------------------- */

export function toPartyDto(p: LeasePartyRow): LeasePartyDto {
  return {
    id: p.id,
    leaseId: p.leaseId,
    userId: p.userId,
    role: p.role,
    name: p.name,
    email: p.email,
    phoneE164: p.phoneE164,
    accessStatus: p.accessStatus,
    invitedAt: iso(p.invitedAt),
    invitationExpiresAt: iso(p.invitationExpiresAt),
    acceptedAt: iso(p.acceptedAt),
    revokedAt: iso(p.revokedAt),
    createdAt: p.createdAt.toISOString(),
  };
}

export function toLeaseDto(
  row: LeaseRow,
  parties: LeasePartyRow[],
  terms: Partial<LeaseTermsDto> | null,
): LeaseDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    unitId: row.unitId,
    kind: row.kind,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    rentAmountKobo: row.rentAmountKobo.toString(),
    rentPeriod: row.rentPeriod,
    currency: row.currency,
    depositKobo: row.depositKobo.toString(),
    managementFeeBasis: row.managementFeeBasis,
    managementFeeBps: row.managementFeeBps,
    managementFeeFixedKobo: kobo(row.managementFeeFixedKobo),
    termsFileId: row.termsFileId,
    academicPeriod: row.academicPeriod,
    noticePeriodDays: row.noticePeriodDays,
    terminatedAt: iso(row.terminatedAt),
    terminationReason: row.terminationReason,
    terms,
    parties: parties.map(toPartyDto),
    createdBy: row.createdBy,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Rows of `user` for a set of ids (no row-level policy on the user table). */
export async function userNames(
  tx: DbExecutor,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Keyset cursor helpers (createdAt + id). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [isoText, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!isoText || !id) return null;
    const createdAt = new Date(isoText);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

/** Resolves the organisation a staff member acts for, or the customer's active organisation. */
export function resolveOrganization(
  identity: RequestIdentity,
  requested: string | undefined,
): string {
  const active = identity.ctx.organizationId;
  if (isStaffIdentity(identity) && !active) {
    if (!requested)
      throw new ApiError('validation_failed', 'organizationId is required when acting as staff', {
        details: [{ path: 'organizationId', message: 'required' }],
      });
    return requested;
  }
  if (!active)
    throw new ApiError('forbidden', 'join an organisation first', {
      details: { code: 'no_organization' },
    });
  if (requested && requested !== active)
    throw new ApiError('forbidden', 'records can only be created in the active organisation');
  return active;
}
