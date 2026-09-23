import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import {
  ApiError,
  type LeaseCreate,
  type LeaseDto,
  type LeaseListQuery,
  type LeaseNotice,
  type LeasePartyDto,
  type LeasePartyInvite,
  type LeaseRenew,
  type LeaseTerminate,
  type LeaseTermsDto,
  type LeaseTransition,
  type LeaseUpdate,
  type Page,
  type TenantInvitationAccept,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { evaluateTransition, leaseMachine, type ActorKind } from '@simplexd/domain/workflow';
import {
  addDays,
  generateRentSchedule,
  leaseLifecycleTarget,
  truncateCharge,
} from '@simplexd/domain/rentals';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { isFeatureEnabled } from '@/lib/features';
import { requireProperty } from '@/server/properties/access';
import { generateScheduleForLease } from './schedules';
import {
  FEATURES,
  activePartyUserIds,
  assertLeaseManage,
  assertLeaseRead,
  ctxFor,
  decodeCursor,
  elevated,
  encodeCursor,
  isStaffIdentity,
  loadLeaseTerms,
  loadParties,
  requireLease,
  requireUserId,
  resolveOrganization,
  saveLeaseTerms,
  toLeaseDto,
  toPartyDto,
  today,
  versionConflict,
  type LeaseRow,
  type ServiceOptions,
} from './shared';

/**
 * Lease lifecycle (draft → pending_signature → active → expiring → ended |
 * terminated) through `leaseMachine`; activation generates the rent
 * schedule, the hourly rent job applies the system transitions (expiring
 * inside the notice window, ended after the end date). Tenant parties join
 * through single-use invitation tokens with expiry and revocation; only
 * `active` parties gain tenant access, in the application policy and in
 * `app.can_access_lease` alike. Move-in inventories are part of every lease;
 * guarantors and academic terms are the student-housing variant.
 */

type LeaseInsert = typeof schema.leases.$inferInsert;

function actorKind(identity: RequestIdentity): ActorKind {
  return isStaffIdentity(identity) ? 'staff' : 'customer';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function assertUnit(
  tx: DbExecutor,
  propertyId: string,
  unitId: string | null | undefined,
): Promise<void> {
  if (!unitId) return;
  const [unit] = await tx
    .select({ id: schema.units.id })
    .from(schema.units)
    .where(and(eq(schema.units.id, unitId), eq(schema.units.propertyId, propertyId)));
  if (!unit)
    throw new ApiError('validation_failed', 'unit does not belong to the property', {
      details: [{ path: 'unitId', message: 'unknown unit' }],
    });
}

function assertVariantTerms(
  identity: RequestIdentity,
  input: { kind?: LeaseCreate['kind']; terms?: Partial<LeaseTermsDto> },
): void {
  if (input.kind === 'student_academic' && !isFeatureEnabled(identity, FEATURES.studentHousing)) {
    throw new ApiError('feature_disabled', 'student housing leases are not enabled', {
      details: { feature: FEATURES.studentHousing },
    });
  }
  if (
    (input.terms?.guarantor || input.terms?.academicTerms) &&
    !isFeatureEnabled(identity, FEATURES.studentHousing)
  ) {
    throw new ApiError(
      'feature_disabled',
      'guarantors and academic terms are part of the student housing package',
      { details: { feature: FEATURES.studentHousing } },
    );
  }
}

/** Another active or expiring lease on the same unit whose dates overlap `[start, end]`. */
async function overlappingUnitLease(
  tx: DbExecutor,
  lease: Pick<LeaseRow, 'id' | 'unitId'>,
  start: string,
  end: string | null,
): Promise<string | null> {
  if (!lease.unitId) return null;
  const [row] = await tx
    .select({ id: schema.leases.id })
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.unitId, lease.unitId),
        ne(schema.leases.id, lease.id),
        inArray(schema.leases.status, ['active', 'expiring']),
        end ? lte(schema.leases.startDate, end) : undefined,
        or(isNull(schema.leases.endDate), gte(schema.leases.endDate, start)),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Marks the unit vacant unless another active or expiring lease still occupies it. */
async function releaseUnit(tx: DbExecutor, lease: Pick<LeaseRow, 'id' | 'unitId'>): Promise<void> {
  if (!lease.unitId) return;
  const [other] = await tx
    .select({ id: schema.leases.id })
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.unitId, lease.unitId),
        ne(schema.leases.id, lease.id),
        inArray(schema.leases.status, ['active', 'expiring']),
      ),
    )
    .limit(1);
  if (!other)
    await tx
      .update(schema.units)
      .set({ status: 'vacant' })
      .where(eq(schema.units.id, lease.unitId));
}

/** Validates the schedule the terms would produce so bad terms fail at save time, not at activation. */
function assertScheduleValid(
  row: Pick<LeaseRow, 'startDate' | 'endDate' | 'rentAmountKobo' | 'rentPeriod'>,
  terms: Partial<LeaseTermsDto> | null,
): void {
  try {
    generateRentSchedule({
      startDate: row.startDate,
      endDate: row.endDate,
      rentAmountKobo: row.rentAmountKobo,
      rentPeriod: row.rentPeriod,
      dueLeadDays: terms?.dueLeadDays ?? 0,
      prorate: terms?.prorate ?? true,
      academicTerms: terms?.academicTerms?.map((t) => ({
        label: t.label,
        start: t.start,
        end: t.end,
        ...(t.amountKobo ? { amountKobo: BigInt(t.amountKobo) } : {}),
      })),
      horizonPeriods: 1,
    });
  } catch (err) {
    throw new ApiError('validation_failed', (err as Error).message, {
      details: [{ path: 'terms', message: (err as Error).message }],
    });
  }
}

async function guarantorParty(
  tx: DbExecutor,
  leaseId: string,
  guarantor: NonNullable<LeaseTermsDto['guarantor']>,
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.leaseParties.id })
    .from(schema.leaseParties)
    .where(and(eq(schema.leaseParties.leaseId, leaseId), eq(schema.leaseParties.role, 'guarantor')))
    .limit(1);
  const values = {
    name: guarantor.name,
    email: guarantor.email ?? null,
    phoneE164: guarantor.phoneE164 ?? null,
  };
  if (existing)
    await tx.update(schema.leaseParties).set(values).where(eq(schema.leaseParties.id, existing.id));
  else
    await tx
      .insert(schema.leaseParties)
      .values({ leaseId, role: 'guarantor', accessStatus: 'not_invited', ...values });
}

async function dto(tx: DbExecutor, row: LeaseRow): Promise<LeaseDto> {
  const [parties, terms] = await Promise.all([loadParties(tx, row.id), loadLeaseTerms(tx, row.id)]);
  return toLeaseDto(row, parties, terms);
}

export async function createLease(
  identity: RequestIdentity,
  input: LeaseCreate,
  options: ServiceOptions = {},
): Promise<LeaseDto> {
  const userId = requireUserId(identity);
  assertVariantTerms(identity, input);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const property = await requireProperty(tx, identity, input.propertyId, 'read');
    const organizationId = resolveOrganization(identity, property.organizationId);
    assertLeaseManage(identity, { type: 'lease', organizationId });
    await assertUnit(tx, property.id, input.unitId);
    if (input.managementFeeBasis === 'percentage_of_collected' && !input.managementFeeBps)
      throw new ApiError('validation_failed', 'managementFeeBps is required for a percentage fee');
    if (input.managementFeeBasis === 'fixed_monthly' && !input.managementFeeFixedKobo)
      throw new ApiError('validation_failed', 'managementFeeFixedKobo is required for a fixed fee');
    const terms = input.terms ?? null;
    const values: LeaseInsert = {
      organizationId,
      propertyId: property.id,
      unitId: input.unitId ?? null,
      kind: input.kind,
      status: 'draft',
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      rentAmountKobo: BigInt(input.rentAmountKobo),
      rentPeriod: input.rentPeriod,
      currency: input.currency,
      depositKobo: BigInt(input.depositKobo),
      managementFeeBasis: input.managementFeeBasis,
      managementFeeBps: input.managementFeeBps ?? null,
      managementFeeFixedKobo: input.managementFeeFixedKobo
        ? BigInt(input.managementFeeFixedKobo)
        : null,
      termsFileId: input.termsFileId ?? null,
      academicPeriod: input.academicPeriod ?? null,
      noticePeriodDays: input.noticePeriodDays ?? null,
      createdBy: userId,
    };
    assertScheduleValid(values as LeaseRow, terms);
    const [row] = await tx.insert(schema.leases).values(values).returning();
    if (terms && Object.keys(terms).length > 0) {
      await saveLeaseTerms(tx, { leaseId: row!.id, organizationId, authorUserId: userId, terms });
      if (terms.guarantor) await guarantorParty(tx, row!.id, terms.guarantor);
    }
    await recordAudit(tx, identity, {
      action: 'lease.created',
      entityType: 'lease',
      entityId: row!.id,
      organizationId,
      after: {
        propertyId: property.id,
        unitId: row!.unitId,
        kind: row!.kind,
        rentAmountKobo: row!.rentAmountKobo,
        rentPeriod: row!.rentPeriod,
      },
      correlationId: options.correlationId,
    });
    return dto(tx, row!);
  });
}

export async function getLease(identity: RequestIdentity, id: string): Promise<LeaseDto> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { lease } = await requireLease(tx, identity, id, 'read');
    return dto(tx, lease);
  });
}

export async function listLeases(
  identity: RequestIdentity,
  query: LeaseListQuery,
): Promise<Page<LeaseDto>> {
  requireUserId(identity);
  const staff = isStaffIdentity(identity);
  let organizationId: string | null;
  if (staff) organizationId = query.organizationId ?? identity.ctx.organizationId ?? null;
  else {
    organizationId = identity.ctx.organizationId;
    if (!organizationId) return { items: [], nextCursor: null };
    if (query.organizationId && query.organizationId !== organizationId)
      return { items: [], nextCursor: null };
  }
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.leases)
      .where(
        and(
          organizationId ? eq(schema.leases.organizationId, organizationId) : undefined,
          query.propertyId ? eq(schema.leases.propertyId, query.propertyId) : undefined,
          query.status ? eq(schema.leases.status, query.status) : undefined,
          cursor
            ? or(
                lt(schema.leases.createdAt, cursor.createdAt),
                and(eq(schema.leases.createdAt, cursor.createdAt), lt(schema.leases.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.leases.createdAt), desc(schema.leases.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const items: LeaseDto[] = [];
    for (const row of page) {
      if (!staff) {
        assertLeaseRead(identity, {
          type: 'lease',
          id: row.id,
          organizationId: row.organizationId,
        });
      }
      items.push(await dto(tx, row));
    }
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
  });
}

export async function updateLease(
  identity: RequestIdentity,
  id: string,
  input: LeaseUpdate,
  options: ServiceOptions = {},
): Promise<LeaseDto> {
  const userId = requireUserId(identity);
  assertVariantTerms(identity, input);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, id, 'manage');
    if (lease.version !== input.expectedVersion) throw versionConflict(lease.version);
    if (['ended', 'terminated'].includes(lease.status))
      throw new ApiError('invalid_transition', `a ${lease.status} lease cannot be edited`);
    const financialChange =
      input.startDate !== undefined ||
      input.endDate !== undefined ||
      input.rentAmountKobo !== undefined ||
      input.rentPeriod !== undefined;
    if (financialChange && !['draft', 'pending_signature'].includes(lease.status)) {
      throw new ApiError(
        'invalid_transition',
        'dates, rent and period are fixed once a lease is active; renew or terminate instead',
      );
    }
    await assertUnit(tx, lease.propertyId, input.unitId);
    const patch: Partial<LeaseInsert> = { version: lease.version + 1 };
    if (input.unitId !== undefined) patch.unitId = input.unitId;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.startDate !== undefined) patch.startDate = input.startDate;
    if (input.endDate !== undefined) patch.endDate = input.endDate;
    if (input.rentAmountKobo !== undefined) patch.rentAmountKobo = BigInt(input.rentAmountKobo);
    if (input.rentPeriod !== undefined) patch.rentPeriod = input.rentPeriod;
    if (input.currency !== undefined) patch.currency = input.currency;
    if (input.depositKobo !== undefined) patch.depositKobo = BigInt(input.depositKobo);
    if (input.managementFeeBasis !== undefined) patch.managementFeeBasis = input.managementFeeBasis;
    if (input.managementFeeBps !== undefined) patch.managementFeeBps = input.managementFeeBps;
    if (input.managementFeeFixedKobo !== undefined)
      patch.managementFeeFixedKobo = input.managementFeeFixedKobo
        ? BigInt(input.managementFeeFixedKobo)
        : null;
    if (input.termsFileId !== undefined) patch.termsFileId = input.termsFileId;
    if (input.academicPeriod !== undefined) patch.academicPeriod = input.academicPeriod;
    if (input.noticePeriodDays !== undefined) patch.noticePeriodDays = input.noticePeriodDays;
    const existingTerms = (await loadLeaseTerms(tx, id)) ?? {};
    const terms = input.terms ? { ...existingTerms, ...input.terms } : existingTerms;
    assertScheduleValid({ ...lease, ...patch } as LeaseRow, terms);
    const [row] = await tx
      .update(schema.leases)
      .set(patch)
      .where(and(eq(schema.leases.id, id), eq(schema.leases.version, lease.version)))
      .returning();
    if (!row) throw versionConflict();
    if (input.terms) {
      await saveLeaseTerms(tx, {
        leaseId: id,
        organizationId: lease.organizationId,
        authorUserId: userId,
        terms,
      });
      if (input.terms.guarantor) await guarantorParty(tx, id, input.terms.guarantor);
    }
    const { version: _v, ...changes } = patch;
    await recordAudit(tx, identity, {
      action: 'lease.updated',
      entityType: 'lease',
      entityId: id,
      organizationId: lease.organizationId,
      before: Object.fromEntries(
        Object.keys(changes).map((k) => [k, (lease as Record<string, unknown>)[k] ?? null]),
      ),
      after: { ...changes, terms: input.terms ?? undefined, version: row.version },
      correlationId: options.correlationId,
    });
    return dto(tx, row);
  });
}

interface TransitionActor {
  identity: RequestIdentity | null;
  kind: ActorKind;
  correlationId?: string | undefined;
}

async function applyTransition(
  tx: DbExecutor,
  by: TransitionActor,
  lease: LeaseRow,
  to: LeaseRow['status'],
  extra: Partial<LeaseInsert>,
  reason: string | null,
): Promise<LeaseRow> {
  const decision = evaluateTransition(leaseMachine, {
    from: lease.status,
    to,
    actor: by.kind,
    reason,
  });
  if (!decision.ok)
    throw new ApiError('invalid_transition', decision.message, {
      details: { code: decision.code },
    });
  const [row] = await tx
    .update(schema.leases)
    .set({ status: to, version: lease.version + 1, ...extra })
    .where(and(eq(schema.leases.id, lease.id), eq(schema.leases.version, lease.version)))
    .returning();
  if (!row) throw versionConflict();
  await recordAudit(tx, by.identity, {
    action: `lease.${to}`,
    entityType: 'lease',
    entityId: lease.id,
    organizationId: lease.organizationId,
    before: { status: lease.status, version: lease.version },
    after: { status: to, version: row.version },
    reason,
    correlationId: by.correlationId,
    ...(by.identity ? {} : { actorType: 'job' as const }),
  });
  await appendOutbox(tx, {
    eventType: 'lease.transitioned',
    aggregateType: 'lease',
    aggregateId: lease.id,
    organizationId: lease.organizationId,
    actorUserId: by.identity?.session?.user.id ?? null,
    payload: {
      leaseId: lease.id,
      from: lease.status,
      to,
      reason,
      recipientUserIds: activePartyUserIds(await loadParties(tx, lease.id)),
    },
    correlationId: by.correlationId ?? null,
  });
  return row;
}

function userActor(identity: RequestIdentity, options: ServiceOptions): TransitionActor {
  return { identity, kind: actorKind(identity), correlationId: options.correlationId };
}

/** draft → pending_signature | active; active/expiring → ended (staff). Activation generates the schedule. */
export async function transitionLease(
  identity: RequestIdentity,
  id: string,
  input: LeaseTransition,
  options: ServiceOptions = {},
): Promise<LeaseDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, id, 'manage');
    if (lease.version !== input.expectedVersion) throw versionConflict(lease.version);
    if (input.to === 'ended' && !isStaffIdentity(identity))
      throw new ApiError('forbidden', 'only staff end a lease; owners terminate with a reason');
    if (input.to === 'active') {
      const busy = await overlappingUnitLease(tx, lease, lease.startDate, lease.endDate);
      if (busy)
        throw new ApiError('conflict', 'the unit already has an active lease for that period', {
          details: { leaseId: busy },
        });
    }
    const row = await applyTransition(tx, userActor(identity, options), lease, input.to, {}, null);
    if (input.to === 'active') {
      const terms = await loadLeaseTerms(tx, id);
      const generated = await generateScheduleForLease(tx, row, terms, userId);
      if (lease.unitId)
        await tx
          .update(schema.units)
          .set({ status: 'occupied' })
          .where(eq(schema.units.id, lease.unitId));
      await recordAudit(tx, identity, {
        action: 'lease.schedule_generated',
        entityType: 'lease',
        entityId: id,
        organizationId: lease.organizationId,
        after: generated,
        correlationId: options.correlationId,
      });
    }
    if (input.to === 'ended') await releaseUnit(tx, lease);
    return dto(tx, row);
  });
}

/**
 * Terminates with a reason on `terminatedOn` (default today). Periods not yet
 * invoiced that start after that day are waived; a period not yet invoiced
 * that straddles it is cut at that day and its charges scaled by the days
 * kept (`truncateCharge`). Periods already invoiced stay as issued; finance
 * credits any unused part with a credit note.
 */
export async function terminateLease(
  identity: RequestIdentity,
  id: string,
  input: LeaseTerminate,
  options: ServiceOptions = {},
): Promise<LeaseDto> {
  requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, id, 'manage');
    if (lease.version !== input.expectedVersion) throw versionConflict(lease.version);
    const terminatedOn = input.terminatedOn ?? today();
    if (terminatedOn < lease.startDate || (lease.endDate && terminatedOn > lease.endDate))
      throw new ApiError('validation_failed', 'terminatedOn must fall within the lease term', {
        details: [
          {
            path: 'terminatedOn',
            message: `between ${lease.startDate} and ${lease.endDate ?? 'open'}`,
          },
        ],
      });
    const row = await applyTransition(
      tx,
      userActor(identity, options),
      lease,
      'terminated',
      { terminatedAt: new Date(), terminationReason: input.reason, endDate: terminatedOn },
      input.reason,
    );
    await tx
      .update(schema.rentSchedules)
      .set({ status: 'waived' })
      .where(
        and(
          eq(schema.rentSchedules.leaseId, id),
          eq(schema.rentSchedules.status, 'scheduled'),
          gt(schema.rentSchedules.periodStart, terminatedOn),
        ),
      );
    const [straddling] = await tx
      .select()
      .from(schema.rentSchedules)
      .where(
        and(
          eq(schema.rentSchedules.leaseId, id),
          eq(schema.rentSchedules.status, 'scheduled'),
          lte(schema.rentSchedules.periodStart, terminatedOn),
          gt(schema.rentSchedules.periodEnd, terminatedOn),
        ),
      );
    if (straddling) {
      const charges = await tx
        .select()
        .from(schema.rentCharges)
        .where(
          and(
            eq(schema.rentCharges.scheduleId, straddling.id),
            isNull(schema.rentCharges.invoiceId),
          ),
        );
      let total = 0n;
      for (const c of charges) {
        const amount = truncateCharge(
          c.amountKobo,
          straddling.periodStart,
          straddling.periodEnd,
          terminatedOn,
        );
        total += amount;
        await tx
          .update(schema.rentCharges)
          .set({
            amountKobo: amount,
            description: `${c.description} (to ${terminatedOn} on termination)`,
          })
          .where(eq(schema.rentCharges.id, c.id));
      }
      await tx
        .update(schema.rentSchedules)
        .set({ periodEnd: terminatedOn, amountKobo: total })
        .where(eq(schema.rentSchedules.id, straddling.id));
    }
    await releaseUnit(tx, lease);
    return dto(tx, row);
  });
}

/**
 * Creates the successor lease as a draft with the same parties (active
 * tenants keep their access). A fixed-term lease renews after its end date;
 * the current lease runs to its end and the rent job ends it. An open-ended
 * lease renews at the start of a period not invoiced yet (or after its last
 * generated period): its end date becomes the day before the renewal and
 * its later periods are waived.
 */
export async function renewLease(
  identity: RequestIdentity,
  id: string,
  input: LeaseRenew,
  options: ServiceOptions = {},
): Promise<{ previous: LeaseDto; renewal: LeaseDto }> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, id, 'manage');
    if (lease.version !== input.expectedVersion) throw versionConflict(lease.version);
    if (!['active', 'expiring'].includes(lease.status))
      throw new ApiError(
        'invalid_transition',
        `only active or expiring leases renew (lease is ${lease.status})`,
      );
    let current = lease;
    if (lease.endDate) {
      if (input.startDate <= lease.endDate)
        throw new ApiError('validation_failed', `the renewal starts after ${lease.endDate}`, {
          details: [{ path: 'startDate', message: `after ${lease.endDate}` }],
        });
    } else {
      if (input.startDate <= lease.startDate)
        throw new ApiError('validation_failed', 'the renewal starts after the current lease', {
          details: [{ path: 'startDate', message: `after ${lease.startDate}` }],
        });
      const schedules = await tx
        .select()
        .from(schema.rentSchedules)
        .where(eq(schema.rentSchedules.leaseId, id))
        .orderBy(asc(schema.rentSchedules.periodStart));
      const last = schedules[schedules.length - 1];
      const boundary = schedules.find((s) => s.periodStart === input.startDate);
      const afterLast = !last || input.startDate > last.periodEnd;
      if (!afterLast && boundary?.status !== 'scheduled')
        throw new ApiError(
          'validation_failed',
          'an open-ended lease renews at the start of a rent period that is not invoiced yet',
          { details: [{ path: 'startDate', message: 'not a period boundary' }] },
        );
      await tx
        .update(schema.rentSchedules)
        .set({ status: 'waived' })
        .where(
          and(
            eq(schema.rentSchedules.leaseId, id),
            eq(schema.rentSchedules.status, 'scheduled'),
            gte(schema.rentSchedules.periodStart, input.startDate),
          ),
        );
      const [shortened] = await tx
        .update(schema.leases)
        .set({ endDate: addDays(input.startDate, -1), version: lease.version + 1 })
        .where(and(eq(schema.leases.id, id), eq(schema.leases.version, lease.version)))
        .returning();
      if (!shortened) throw versionConflict();
      current = shortened;
    }
    const terms = await loadLeaseTerms(tx, id);
    const {
      id: _id,
      version: _version,
      createdAt: _c,
      updatedAt: _u,
      status: _s,
      terminatedAt: _t,
      terminationReason: _r,
      ...copy
    } = lease;
    const values: LeaseInsert = {
      ...copy,
      status: 'draft',
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      rentAmountKobo: input.rentAmountKobo ? BigInt(input.rentAmountKobo) : lease.rentAmountKobo,
      createdBy: userId,
    };
    assertScheduleValid(values as LeaseRow, terms);
    const [renewal] = await tx.insert(schema.leases).values(values).returning();
    if (terms)
      await saveLeaseTerms(tx, {
        leaseId: renewal!.id,
        organizationId: lease.organizationId,
        authorUserId: userId,
        terms,
      });
    // Parties carry over with their access; the tenant does not need a new invitation.
    const parties = await loadParties(tx, id);
    for (const p of parties) {
      await tx.insert(schema.leaseParties).values({
        leaseId: renewal!.id,
        userId: p.userId,
        role: p.role,
        name: p.name,
        email: p.email,
        phoneE164: p.phoneE164,
        accessStatus: p.accessStatus === 'active' ? 'active' : 'not_invited',
        acceptedAt: p.accessStatus === 'active' ? p.acceptedAt : null,
      });
    }
    await recordAudit(tx, identity, {
      action: 'lease.renewed',
      entityType: 'lease',
      entityId: id,
      organizationId: lease.organizationId,
      before: { endDate: lease.endDate, version: lease.version },
      after: {
        endDate: current.endDate,
        renewalLeaseId: renewal!.id,
        startDate: input.startDate,
        renewalEndDate: input.endDate ?? null,
        rentAmountKobo: values.rentAmountKobo,
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'lease.renewed',
      aggregateType: 'lease',
      aggregateId: id,
      organizationId: lease.organizationId,
      actorUserId: userId,
      payload: {
        leaseId: id,
        renewalLeaseId: renewal!.id,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        recipientUserIds: activePartyUserIds(parties),
      },
      correlationId: options.correlationId ?? null,
    });
    return { previous: await dto(tx, current), renewal: await dto(tx, renewal!) };
  });
}

/**
 * System lifecycle step for one lease (rent job, system context): moves an
 * active lease to `expiring` inside its notice window and an active or
 * expiring lease to `ended` after its end date, releasing the unit.
 */
export async function advanceLeaseLifecycle(
  tx: DbExecutor,
  lease: LeaseRow,
  asOf: string,
  correlationId?: string,
): Promise<LeaseRow['status'] | null> {
  const target = leaseLifecycleTarget(lease, asOf);
  if (!target) return null;
  await applyTransition(
    tx,
    { identity: null, kind: 'system', correlationId },
    lease,
    target,
    {},
    null,
  );
  if (target === 'ended') await releaseUnit(tx, lease);
  return target;
}

/* ---------------------------------------------------------------------- */
/* Parties and invitations                                                 */
/* ---------------------------------------------------------------------- */

export async function inviteParty(
  identity: RequestIdentity,
  leaseId: string,
  input: LeasePartyInvite,
  options: ServiceOptions = {},
): Promise<LeasePartyDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, leaseId, 'manage');
    if (['ended', 'terminated'].includes(lease.status))
      throw new ApiError('invalid_transition', 'parties cannot be invited to an ended lease');
    const email = input.email.toLowerCase();
    const [existing] = await tx
      .select()
      .from(schema.leaseParties)
      .where(
        and(
          eq(schema.leaseParties.leaseId, leaseId),
          eq(schema.leaseParties.email, email),
          eq(schema.leaseParties.role, input.role),
        ),
      )
      .limit(1);
    if (existing?.accessStatus === 'active')
      throw new ApiError('conflict', 'this person already has active access to the lease');
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
    const values = {
      name: input.name,
      email,
      phoneE164: input.phoneE164 ?? null,
      invitationTokenHash: hashToken(token),
      accessStatus: 'invited' as const,
      invitedAt: now,
      invitationExpiresAt: expiresAt,
      revokedAt: null,
      revokedBy: null,
    };
    const [row] = existing
      ? await tx
          .update(schema.leaseParties)
          .set(values)
          .where(eq(schema.leaseParties.id, existing.id))
          .returning()
      : await tx
          .insert(schema.leaseParties)
          .values({ leaseId, role: input.role, ...values })
          .returning();
    await recordAudit(tx, identity, {
      action: 'lease_party.invited',
      entityType: 'lease_party',
      entityId: row!.id,
      organizationId: lease.organizationId,
      after: { leaseId, role: input.role, email, expiresAt },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'tenant.invited',
      aggregateType: 'lease_party',
      aggregateId: row!.id,
      organizationId: lease.organizationId,
      actorUserId: userId,
      payload: {
        leaseId,
        partyId: row!.id,
        role: input.role,
        name: input.name,
        email,
        expiresAt: expiresAt.toISOString(),
        invitationLink: `/tenant/invitations/accept?token=${token}`,
      },
      correlationId: options.correlationId ?? null,
    });
    return toPartyDto(row!);
  });
}

/**
 * The invited person, signed in with the invited e-mail address, redeems the
 * token once. The party row is invisible to them until it is active, so the
 * lookup and the update run elevated after the token and e-mail were checked.
 */
export async function acceptTenantInvitation(
  identity: RequestIdentity,
  input: TenantInvitationAccept,
  options: ServiceOptions = {},
): Promise<LeasePartyDto> {
  const userId = requireUserId(identity);
  const sessionEmail = identity.session?.user.email?.toLowerCase() ?? null;
  const ctx = ctxFor(identity, options);
  const hash = hashToken(input.token);
  const outcome = await withActor(getDb(), ctx, async (tx) =>
    elevated(
      tx,
      ctx,
      async (): Promise<{ kind: 'expired' } | { kind: 'accepted'; party: LeasePartyDto }> => {
        const [party] = await tx
          .select()
          .from(schema.leaseParties)
          .where(eq(schema.leaseParties.invitationTokenHash, hash))
          .limit(1);
        if (!party || party.accessStatus !== 'invited')
          throw new ApiError('not_found', 'invitation not found or already used');
        const now = new Date();
        if (party.invitationExpiresAt && party.invitationExpiresAt.getTime() < now.getTime()) {
          // Committed on its own: the expiry mark must survive the error returned to the caller.
          await tx
            .update(schema.leaseParties)
            .set({ accessStatus: 'expired', invitationTokenHash: null })
            .where(eq(schema.leaseParties.id, party.id));
          return { kind: 'expired' };
        }
        if (party.email && sessionEmail && party.email.toLowerCase() !== sessionEmail)
          throw new ApiError(
            'forbidden',
            'sign in with the invited e-mail address to accept this invitation',
          );
        const [row] = await tx
          .update(schema.leaseParties)
          .set({ userId, accessStatus: 'active', acceptedAt: now, invitationTokenHash: null })
          .where(
            and(
              eq(schema.leaseParties.id, party.id),
              eq(schema.leaseParties.accessStatus, 'invited'),
            ),
          )
          .returning();
        if (!row) throw new ApiError('conflict', 'invitation was redeemed concurrently');
        const [lease] = await tx
          .select({ organizationId: schema.leases.organizationId })
          .from(schema.leases)
          .where(eq(schema.leases.id, party.leaseId));
        await recordAudit(tx, identity, {
          action: 'lease_party.accepted',
          entityType: 'lease_party',
          entityId: row.id,
          organizationId: lease?.organizationId ?? null,
          after: { leaseId: row.leaseId, role: row.role },
          correlationId: options.correlationId,
        });
        return { kind: 'accepted', party: toPartyDto(row) };
      },
    ),
  );
  if (outcome.kind === 'expired')
    throw new ApiError('conflict', 'this invitation has expired; ask for a new one');
  return outcome.party;
}

/** Revocation removes tenant access the moment the transaction commits (policy and RLS both read `active`). */
export async function revokeParty(
  identity: RequestIdentity,
  leaseId: string,
  partyId: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<LeasePartyDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { lease } = await requireLease(tx, identity, leaseId, 'manage');
    const [party] = await tx
      .select()
      .from(schema.leaseParties)
      .where(and(eq(schema.leaseParties.id, partyId), eq(schema.leaseParties.leaseId, leaseId)));
    if (!party) throw new ApiError('not_found', 'party not found');
    if (party.accessStatus === 'revoked') return toPartyDto(party);
    const [row] = await tx
      .update(schema.leaseParties)
      .set({
        accessStatus: 'revoked',
        revokedAt: new Date(),
        revokedBy: userId,
        invitationTokenHash: null,
      })
      .where(eq(schema.leaseParties.id, partyId))
      .returning();
    await recordAudit(tx, identity, {
      action: 'lease_party.revoked',
      entityType: 'lease_party',
      entityId: partyId,
      organizationId: lease.organizationId,
      before: { accessStatus: party.accessStatus },
      after: { accessStatus: 'revoked' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return toPartyDto(row!);
  });
}

export async function listParties(
  identity: RequestIdentity,
  leaseId: string,
): Promise<LeasePartyDto[]> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { parties, viewer } = await requireLease(tx, identity, leaseId, 'read');
    const userId = identity.session!.user.id;
    // A tenant sees only their own party record, never the other occupants.
    return parties.filter((p) => viewer !== 'tenant' || p.userId === userId).map(toPartyDto);
  });
}

/** Expires stale invitations (job). */
export async function expireInvitations(tx: DbExecutor, now: Date = new Date()): Promise<number> {
  const rows = await tx
    .update(schema.leaseParties)
    .set({ accessStatus: 'expired', invitationTokenHash: null })
    .where(
      and(
        eq(schema.leaseParties.accessStatus, 'invited'),
        lt(schema.leaseParties.invitationExpiresAt, now),
      ),
    )
    .returning({ id: schema.leaseParties.id });
  return rows.length;
}

/* ---------------------------------------------------------------------- */
/* Notices                                                                 */
/* ---------------------------------------------------------------------- */

/** An approved notice to the lease's active tenants, delivered as in-app notifications (and e-mail through the outbox). */
export async function postLeaseNotice(
  identity: RequestIdentity,
  leaseId: string,
  input: LeaseNotice,
  options: ServiceOptions = {},
): Promise<{ recipients: number }> {
  const userId = requireUserId(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { lease, parties } = await requireLease(tx, identity, leaseId, 'manage');
    const recipients = activePartyUserIds(parties);
    await elevated(tx, ctx, async () => {
      for (const recipient of recipients) {
        await tx.insert(schema.notifications).values({
          userId: recipient,
          organizationId: lease.organizationId,
          category: 'transactional',
          kind: 'tenant_notice',
          title: input.title,
          body: input.body,
          linkPath: `/tenant/leases/${leaseId}`,
          entityType: 'lease',
          entityId: leaseId,
        });
      }
    });
    await recordAudit(tx, identity, {
      action: 'lease.notice_posted',
      entityType: 'lease',
      entityId: leaseId,
      organizationId: lease.organizationId,
      after: { title: input.title, recipients: recipients.length },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'tenant.notice',
      aggregateType: 'lease',
      aggregateId: leaseId,
      organizationId: lease.organizationId,
      actorUserId: userId,
      payload: { leaseId, title: input.title, body: input.body, recipientUserIds: recipients },
      correlationId: options.correlationId ?? null,
    });
    return { recipients: recipients.length };
  });
}
