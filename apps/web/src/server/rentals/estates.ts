import 'server-only';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiError,
  type EstateCreate,
  type EstateDto,
  type EstateServiceChargeRun,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { createInvoiceRecord, issueInvoiceTx } from '@simplexd/finance';
import { assertAllowed, authorizeAny, type ResourceRef } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  FEATURES,
  ctxFor,
  elevated,
  requireFlag,
  requireUserId,
  resolveOrganization,
  systemActorFor,
  today,
  type ServiceOptions,
} from './shared';

/**
 * Facilities / estate management (`expansion.estate_management`): an estate
 * groups properties of one owner organisation under a ledger segment so its
 * accounting stays separate. Service charges are invoiced to every active
 * lease in the estate as `service_charge` invoices carrying the segment;
 * resident issues are work orders scoped to the estate; shared assets are
 * asset-register rows with `estate_id`.
 */

type EstateRow = typeof schema.estates.$inferSelect;

function ref(organizationId: string, id?: string): ResourceRef {
  return { type: 'estate', id, organizationId };
}

function assertManage(identity: RequestIdentity, r: ResourceRef): void {
  assertAllowed(
    authorizeAny(
      identity.actor,
      [{ staff: 'estates.manage' }, { org: 'org.properties.manage' }],
      r,
    ),
  );
}

function assertRead(identity: RequestIdentity, r: ResourceRef): void {
  assertAllowed(
    authorizeAny(
      identity.actor,
      [
        { staff: 'estates.manage' },
        { staff: 'rentals.manage' },
        { staff: 'customers.read' },
        { org: 'org.read' },
      ],
      r,
    ),
  );
}

async function toDto(tx: DbExecutor, row: EstateRow): Promise<EstateDto> {
  const props = await tx
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.estateId, row.id))
    .orderBy(asc(schema.properties.name));
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    marketId: row.marketId,
    serviceChargePolicy: (row.serviceChargePolicy as Record<string, unknown> | null) ?? null,
    visitorPolicyWebhookUrl: row.visitorPolicyWebhookUrl,
    ledgerSegment: row.ledgerSegment,
    propertyIds: props.map((p) => p.id),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function segmentFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `estate-${base || 'x'}-${Date.now().toString(36).slice(-4)}`;
}

export async function createEstate(
  identity: RequestIdentity,
  input: EstateCreate,
  options: ServiceOptions = {},
): Promise<EstateDto> {
  requireFlag(identity, FEATURES.estateManagement);
  requireUserId(identity);
  const organizationId = resolveOrganization(identity, input.organizationId);
  assertManage(identity, ref(organizationId));
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [row] = await tx
      .insert(schema.estates)
      .values({
        organizationId,
        name: input.name,
        marketId: input.marketId ?? null,
        serviceChargePolicy: input.serviceChargePolicy ?? null,
        visitorPolicyWebhookUrl: input.visitorPolicyWebhookUrl ?? null,
        ledgerSegment: input.ledgerSegment ?? segmentFromName(input.name),
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'estate.created',
      entityType: 'estate',
      entityId: row!.id,
      organizationId,
      after: { name: input.name, ledgerSegment: row!.ledgerSegment },
      correlationId: options.correlationId,
    });
    return toDto(tx, row!);
  });
}

async function requireEstate(
  tx: DbExecutor,
  identity: RequestIdentity,
  id: string,
  mode: 'read' | 'manage',
): Promise<EstateRow> {
  const [row] = await tx.select().from(schema.estates).where(eq(schema.estates.id, id));
  if (!row) throw new ApiError('not_found', 'estate not found');
  if (mode === 'manage') assertManage(identity, ref(row.organizationId, row.id));
  else assertRead(identity, ref(row.organizationId, row.id));
  return row;
}

export async function getEstate(identity: RequestIdentity, id: string): Promise<EstateDto> {
  requireFlag(identity, FEATURES.estateManagement);
  return withActor(getDb(), identity.ctx, async (tx) =>
    toDto(tx, await requireEstate(tx, identity, id, 'read')),
  );
}

export async function listEstates(
  identity: RequestIdentity,
  query: { organizationId?: string },
): Promise<EstateDto[]> {
  requireFlag(identity, FEATURES.estateManagement);
  requireUserId(identity);
  const staff = identity.actor.staffRoles.length > 0;
  const orgId = staff ? (query.organizationId ?? null) : identity.ctx.organizationId;
  if (!staff && !orgId) return [];
  if (orgId) assertRead(identity, ref(orgId));
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.estates)
      .where(orgId ? eq(schema.estates.organizationId, orgId) : undefined)
      .orderBy(asc(schema.estates.name));
    const out: EstateDto[] = [];
    for (const r of rows) out.push(await toDto(tx, r));
    return out;
  });
}

/** Attaches a property of the same organisation to the estate. */
export async function attachProperty(
  identity: RequestIdentity,
  estateId: string,
  propertyId: string,
  options: ServiceOptions = {},
): Promise<EstateDto> {
  requireFlag(identity, FEATURES.estateManagement);
  requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const estate = await requireEstate(tx, identity, estateId, 'manage');
    const [property] = await tx
      .select({ id: schema.properties.id, organizationId: schema.properties.organizationId })
      .from(schema.properties)
      .where(eq(schema.properties.id, propertyId));
    if (!property || property.organizationId !== estate.organizationId)
      throw new ApiError('not_found', 'property not found');
    await tx
      .update(schema.properties)
      .set({ estateId })
      .where(eq(schema.properties.id, propertyId));
    await recordAudit(tx, identity, {
      action: 'estate.property_attached',
      entityType: 'estate',
      entityId: estateId,
      organizationId: estate.organizationId,
      after: { propertyId },
      correlationId: options.correlationId,
    });
    return toDto(tx, estate);
  });
}

/**
 * Raises the period's service charge on every active lease in the estate and
 * issues one `service_charge` invoice per lease on the estate segment. Leases
 * that already carry a service charge for the period are skipped.
 */
export async function runServiceCharges(
  identity: RequestIdentity,
  estateId: string,
  input: EstateServiceChargeRun,
  options: ServiceOptions = {},
): Promise<{ invoiced: number; skipped: number; invoiceIds: string[] }> {
  requireFlag(identity, FEATURES.estateManagement);
  const userId = requireUserId(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const estate = await requireEstate(tx, identity, estateId, 'manage');
    assertAllowed(
      authorizeAny(
        identity.actor,
        [{ staff: 'estates.manage' }],
        ref(estate.organizationId, estate.id),
      ),
    );
    const policy =
      (estate.serviceChargePolicy as { amountKobo?: string; description?: string } | null) ?? null;
    const amountText = input.amountKobo ?? policy?.amountKobo;
    if (!amountText)
      throw new ApiError(
        'validation_failed',
        'the estate has no service charge policy; pass amountKobo',
      );
    const amount = BigInt(amountText);
    if (amount <= 0n) throw new ApiError('validation_failed', 'service charge must be positive');
    const propertyIds = (
      await tx
        .select({ id: schema.properties.id })
        .from(schema.properties)
        .where(eq(schema.properties.estateId, estateId))
    ).map((p) => p.id);
    if (propertyIds.length === 0) return { invoiced: 0, skipped: 0, invoiceIds: [] };
    const leases = await tx
      .select()
      .from(schema.leases)
      .where(
        and(
          inArray(schema.leases.propertyId, propertyIds),
          inArray(schema.leases.status, ['active', 'expiring']),
        ),
      );
    const description = `${policy?.description ?? 'Estate service charge'} ${input.periodStart} to ${input.periodEnd}`;
    const dueDate = input.dueDate ?? today();
    const fa = systemActorFor(identity, options.correlationId);
    const result = { invoiced: 0, skipped: 0, invoiceIds: [] as string[] };
    for (const lease of leases) {
      const [dup] = await tx
        .select({ id: schema.rentCharges.id })
        .from(schema.rentCharges)
        .where(
          and(
            eq(schema.rentCharges.leaseId, lease.id),
            eq(schema.rentCharges.kind, 'service_charge'),
            eq(schema.rentCharges.estateId, estateId),
            eq(schema.rentCharges.description, description),
          ),
        )
        .limit(1);
      if (dup) {
        result.skipped += 1;
        continue;
      }
      const [charge] = await tx
        .insert(schema.rentCharges)
        .values({
          leaseId: lease.id,
          kind: 'service_charge',
          description,
          amountKobo: amount,
          chargedAt: dueDate,
          estateId,
          createdBy: userId,
        })
        .returning();
      const [tenant] = await tx
        .select({ userId: schema.leaseParties.userId })
        .from(schema.leaseParties)
        .where(
          and(
            eq(schema.leaseParties.leaseId, lease.id),
            eq(schema.leaseParties.role, 'tenant'),
            eq(schema.leaseParties.accessStatus, 'active'),
          ),
        )
        .limit(1);
      const invoiceId = await elevated(tx, ctx, async () => {
        const draft = await createInvoiceRecord(tx, fa, {
          organizationId: lease.organizationId,
          customerUserId: tenant?.userId ?? null,
          kind: 'service_charge',
          currency: lease.currency,
          dueDate,
          notes: description,
          lines: [{ description, quantity: '1', unitAmountKobo: amount.toString() }],
          createdBy: userId,
        });
        // Collected for the owner (the invoice organisation); `ownerOrganizationId` stays null for
        // the reason given in schedules.ts (`invoiceIssued` would write it into a uuid column).
        const [linked] = await tx
          .update(schema.invoices)
          .set({
            leaseId: lease.id,
            isRentOnBehalfOfOwner: true,
            ownerOrganizationId: null,
            estateSegment: estate.ledgerSegment,
          })
          .where(eq(schema.invoices.id, draft.id))
          .returning();
        const issued = await issueInvoiceTx(tx, fa, linked!, { now: new Date(), dueDate });
        return issued.id;
      });
      await tx
        .update(schema.rentCharges)
        .set({ invoiceId })
        .where(eq(schema.rentCharges.id, charge!.id));
      result.invoiced += 1;
      result.invoiceIds.push(invoiceId);
    }
    await recordAudit(tx, identity, {
      action: 'estate.service_charges_run',
      entityType: 'estate',
      entityId: estateId,
      organizationId: estate.organizationId,
      after: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amountKobo: amount,
        ...result,
      },
      correlationId: options.correlationId,
    });
    return result;
  });
}

/** Unassigned charges raised on the estate (for the estate dashboard). */
export async function estateOpenCharges(tx: DbExecutor, estateId: string) {
  return tx
    .select()
    .from(schema.rentCharges)
    .where(and(eq(schema.rentCharges.estateId, estateId), isNull(schema.rentCharges.invoiceId)))
    .orderBy(sql`${schema.rentCharges.chargedAt} desc`);
}
