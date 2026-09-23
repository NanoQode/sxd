import 'server-only';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type Page,
  type PartnerInvoiceDto,
  type PartnerInvoiceListQuery,
  type PartnerInvoiceSourceType,
  type PartnerInvoiceSubmit,
} from '@simplexd/contracts';
import {
  appendOutbox,
  applyActorContext,
  getDb,
  schema,
  withActor,
  type ActorContext,
  type Transaction,
} from '@simplexd/db';
import {
  assertAllowed,
  authorizePartner,
  authorizeStaff,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import {
  ownerPayoutSettled,
  partnerInvoiceAcceptanceReversed,
  partnerInvoiceAccepted,
} from '@simplexd/domain/ledger';
import { evaluateTransition, payoutMachine, type ActorKind } from '@simplexd/domain/workflow';
import { postJournal } from '@simplexd/finance';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';
import { decodeCursor, encodeCursor, iso, userNameMap } from '@/server/assignments/shared';

/**
 * Partner invoices: a partner bills SimplexD for an awarded purchase order or
 * a completed assignment; finance reviews it; an accepted invoice is a
 * payable that leaves the bank only after two different approvers and a
 * recorded settlement.
 *
 * No new table: an invoice is a `payouts` row of kind `partner_invoice`. The
 * partner's submission (reference, source, attachment, review, history) lives
 * in the row's `beneficiary` JSON, and the status is the payout machine:
 *
 *   proposed (submitted) → first_approved (accepted by finance, payable posted
 *   Dr 5200|5300 / Cr 2400) → approved (second approver, different person) →
 *   submitted (transfer sent) → settled (Dr 2400 / Cr 1000) | failed
 *   proposed | first_approved → rejected (reason; a posted payable is reversed)
 *
 * The `payouts` policy is organisation-scoped, so a partner's reads and the
 * insert run elevated after the explicit checks; the SQL always filters on
 * `proposed_by = partner` for them.
 */

export const PARTNER_INVOICE_KIND = 'partner_invoice';

export interface ServiceOptions {
  correlationId?: string;
}

type PayoutRow = typeof schema.payouts.$inferSelect;
type PayoutStatus = PayoutRow['status'];

interface HistoryEntry {
  at: string;
  action: string;
  byUserId: string | null;
  note: string | null;
}

/** Stored in `payouts.beneficiary` for kind `partner_invoice`. */
export interface PartnerInvoiceJson {
  version: 1;
  kind: typeof PARTNER_INVOICE_KIND;
  partnerUserId: string;
  partnerName: string | null;
  partnerOrganizationId: string | null;
  source: { type: PartnerInvoiceSourceType; id: string; label: string };
  reference: string;
  description: string | null;
  attachmentFileId: string | null;
  submittedAt: string;
  review: {
    decision: 'accepted' | 'rejected';
    reason: string | null;
    byUserId: string | null;
    at: string;
  } | null;
  history: HistoryEntry[];
}

/** Statuses that still count against a purchase order's total. */
const COMMITTED: readonly PayoutStatus[] = [
  'proposed',
  'first_approved',
  'approved',
  'submitted',
  'settled',
];

/** Purchase orders a supplier may bill: issued (awarded) or beyond, never draft or cancelled. */
const BILLABLE_PO: ReadonlySet<string> = new Set([
  'issued',
  'acknowledged',
  'partially_delivered',
  'delivered',
  'closed',
]);

function ctxFor(identity: RequestIdentity, options: ServiceOptions): ActorContext {
  return options.correlationId
    ? { ...identity.ctx, correlationId: options.correlationId }
    : identity.ctx;
}

function requireUserId(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

function isStaff(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

function isPartnerOnly(identity: RequestIdentity): boolean {
  return identity.actor.isPartner && !isStaff(identity);
}

/** Runs `fn` with the transaction elevated, restoring the caller's context afterwards. */
async function elevated<T>(tx: Transaction, ctx: ActorContext, fn: () => Promise<T>): Promise<T> {
  if (ctx.bypass) return fn();
  await applyActorContext(tx, { ...ctx, bypass: true });
  const result = await fn();
  await applyActorContext(tx, { ...ctx, bypass: false });
  return result;
}

function parseJson(row: PayoutRow): PartnerInvoiceJson {
  const raw = (row.beneficiary ?? {}) as Partial<PartnerInvoiceJson>;
  if (raw.kind !== PARTNER_INVOICE_KIND || !raw.partnerUserId || !raw.source) {
    throw new ApiError('internal_error', 'payout row is not a partner invoice', {
      details: { payoutId: row.id },
    });
  }
  return {
    version: 1,
    kind: PARTNER_INVOICE_KIND,
    partnerUserId: raw.partnerUserId,
    partnerName: raw.partnerName ?? null,
    partnerOrganizationId: raw.partnerOrganizationId ?? null,
    source: raw.source,
    reference: raw.reference ?? '',
    description: raw.description ?? null,
    attachmentFileId: raw.attachmentFileId ?? null,
    submittedAt: raw.submittedAt ?? row.createdAt.toISOString(),
    review: raw.review ?? null,
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

async function toDto(tx: Transaction, row: PayoutRow): Promise<PartnerInvoiceDto> {
  const json = parseJson(row);
  const names = await userNameMap(tx, [
    json.partnerUserId,
    json.review?.byUserId,
    ...json.history.map((h) => h.byUserId),
  ]);
  const [org] = await tx
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, row.organizationId));
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: org?.name ?? null,
    partnerUserId: json.partnerUserId,
    partnerName: json.partnerName ?? names.get(json.partnerUserId) ?? null,
    source: json.source,
    reference: json.reference,
    description: json.description,
    attachmentFileId: json.attachmentFileId,
    amountKobo: row.amountKobo.toString(),
    currency: row.currency,
    status: row.status,
    submittedAt: json.submittedAt,
    review: json.review
      ? {
          decision: json.review.decision,
          reason: json.review.reason,
          byUserId: json.review.byUserId,
          byName: json.review.byUserId ? (names.get(json.review.byUserId) ?? null) : null,
          at: json.review.at,
        }
      : null,
    firstApproverId: row.firstApproverId,
    firstApprovedAt: iso(row.firstApprovedAt),
    secondApproverId: row.secondApproverId,
    secondApprovedAt: iso(row.secondApprovedAt),
    paymentSubmittedAt: iso(row.submittedAt),
    settledAt: iso(row.settledAt),
    failureReason: row.failureReason,
    journalId: row.journalId,
    history: json.history.map((h) => ({
      at: h.at,
      action: h.action,
      byUserId: h.byUserId,
      byName: h.byUserId ? (names.get(h.byUserId) ?? null) : null,
      note: h.note,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ref(row: PayoutRow, json: PartnerInvoiceJson): ResourceRef {
  return {
    type: 'partner_invoice',
    id: row.id,
    organizationId: row.organizationId,
    createdBy: json.partnerUserId,
    assigneeUserIds: [json.partnerUserId],
    attributes: { firstApproverId: row.firstApproverId },
  };
}

/* ---------------------------------------------------------------------- */
/* Submission (partner)                                                    */
/* ---------------------------------------------------------------------- */

interface BillableSource {
  organizationId: string;
  label: string;
  /** Ceiling for all committed invoices against this source, when the source has a contract value. */
  capKobo: bigint | null;
}

/** Loads the billed record under the partner's own row-level context and checks it may be billed by them. */
async function loadBillableSource(
  tx: Transaction,
  identity: RequestIdentity,
  userId: string,
  source: PartnerInvoiceSubmit['source'],
): Promise<BillableSource> {
  if (source.type === 'purchase_order') {
    requireFeature(identity, 'expansion.materials_procurement');
    const [po] = await tx
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, source.id));
    if (!po || po.supplierUserId !== userId)
      throw new ApiError('not_found', 'purchase order not found');
    if (!BILLABLE_PO.has(po.status)) {
      throw new ApiError(
        'invalid_transition',
        `a ${po.status} purchase order cannot be invoiced; it must have been issued to you`,
      );
    }
    return {
      organizationId: po.organizationId,
      label: `Purchase order ${po.number}`,
      capKobo: po.totalKobo,
    };
  }
  const [assignment] = await tx
    .select()
    .from(schema.assignments)
    .where(eq(schema.assignments.id, source.id));
  if (!assignment || assignment.assigneeUserId !== userId)
    throw new ApiError('not_found', 'assignment not found');
  if (assignment.status !== 'completed') {
    throw new ApiError(
      'invalid_transition',
      `a ${assignment.status} assignment cannot be invoiced; only completed assignments can`,
    );
  }
  return {
    organizationId: assignment.organizationId,
    label: `${assignment.role.replace(/_/g, ' ')} assignment`,
    capKobo: null,
  };
}

async function requireOwnCleanFile(
  tx: Transaction,
  userId: string,
  fileId: string,
): Promise<void> {
  const [file] = await tx
    .select({
      id: schema.fileObjects.id,
      ownerUserId: schema.fileObjects.ownerUserId,
      status: schema.fileObjects.status,
      deletedAt: schema.fileObjects.deletedAt,
    })
    .from(schema.fileObjects)
    .where(eq(schema.fileObjects.id, fileId));
  if (!file || file.ownerUserId !== userId) {
    throw new ApiError('validation_failed', 'the attachment must be a file you uploaded', {
      details: [{ path: 'attachmentFileId', message: `unknown file ${fileId}` }],
    });
  }
  if (file.deletedAt || ['infected', 'scan_failed', 'rejected', 'deleted'].includes(file.status)) {
    throw new ApiError('file_rejected', `the attachment is ${file.status} and cannot be used`);
  }
  if (file.status !== 'clean') {
    throw new ApiError(
      'file_quarantined',
      'the attachment has not passed malware scanning yet; retry after it is scanned',
      { details: { fileId, status: file.status }, retryable: true },
    );
  }
}

export async function submitPartnerInvoice(
  identity: RequestIdentity,
  input: PartnerInvoiceSubmit,
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  const userId = requireUserId(identity);
  if (!isPartnerOnly(identity))
    throw new ApiError('forbidden', 'only partner accounts submit partner invoices');
  assertAllowed(
    authorizePartner(identity.actor, 'partner.invoices.submit', {
      type: 'partner_invoice',
      assigneeUserIds: [userId],
    }),
  );
  const amount = BigInt(input.amountKobo);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const source = await loadBillableSource(tx, identity, userId, input.source);
    await requireOwnCleanFile(tx, userId, input.attachmentFileId);
    const [profile] = await tx
      .select({
        displayName: schema.partnerProfiles.displayName,
        organizationId: schema.partnerProfiles.organizationId,
      })
      .from(schema.partnerProfiles)
      .where(eq(schema.partnerProfiles.userId, userId));
    const row = await elevated(tx, ctx, async () => {
      const duplicate = await tx
        .select({ id: schema.payouts.id })
        .from(schema.payouts)
        .where(
          and(
            eq(schema.payouts.kind, PARTNER_INVOICE_KIND),
            eq(schema.payouts.proposedBy, userId),
            ne(schema.payouts.status, 'rejected'),
            sql`${schema.payouts.beneficiary}->>'reference' = ${input.reference}`,
          ),
        )
        .limit(1);
      if (duplicate.length > 0) {
        throw new ApiError('conflict', `you already submitted an invoice with reference ${input.reference}`, {
          details: { partnerInvoiceId: duplicate[0]!.id },
        });
      }
      if (source.capKobo !== null) {
        const committed = (
          await tx
            .select({ amountKobo: schema.payouts.amountKobo })
            .from(schema.payouts)
            .where(
              and(
                eq(schema.payouts.kind, PARTNER_INVOICE_KIND),
                inArray(schema.payouts.status, [...COMMITTED]),
                sql`${schema.payouts.beneficiary}->'source'->>'id' = ${input.source.id}`,
              ),
            )
        ).reduce((s, p) => s + p.amountKobo, 0n);
        if (committed + amount > source.capKobo) {
          throw new ApiError(
            'validation_failed',
            'this invoice would exceed the purchase order total including invoices already submitted',
            {
              details: {
                orderTotalKobo: source.capKobo.toString(),
                alreadyInvoicedKobo: committed.toString(),
              },
            },
          );
        }
      }
      const now = new Date().toISOString();
      const json: PartnerInvoiceJson = {
        version: 1,
        kind: PARTNER_INVOICE_KIND,
        partnerUserId: userId,
        partnerName: profile?.displayName ?? identity.session?.user.name ?? null,
        partnerOrganizationId: profile?.organizationId ?? null,
        source: { type: input.source.type, id: input.source.id, label: source.label },
        reference: input.reference,
        description: input.description ?? null,
        attachmentFileId: input.attachmentFileId,
        submittedAt: now,
        review: null,
        history: [{ at: now, action: 'submitted', byUserId: userId, note: null }],
      };
      const [inserted] = await tx
        .insert(schema.payouts)
        .values({
          organizationId: source.organizationId,
          kind: PARTNER_INVOICE_KIND,
          amountKobo: amount,
          currency: input.currency,
          status: 'proposed',
          beneficiary: json,
          proposedBy: userId,
        })
        .returning();
      return inserted!;
    });
    await recordAudit(tx, identity, {
      action: 'partner_invoice.submitted',
      entityType: 'partner_invoice',
      entityId: row.id,
      organizationId: source.organizationId,
      after: {
        amountKobo: amount,
        currency: input.currency,
        reference: input.reference,
        source: input.source,
        attachmentFileId: input.attachmentFileId,
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'partner_invoice.submitted',
      aggregateType: 'partner_invoice',
      aggregateId: row.id,
      organizationId: source.organizationId,
      actorUserId: userId,
      payload: {
        partnerInvoiceId: row.id,
        partnerUserId: userId,
        sourceType: input.source.type,
        sourceId: input.source.id,
        amountKobo: amount.toString(),
      },
      correlationId: options.correlationId ?? null,
    });
    return elevated(tx, ctx, () => toDto(tx, row));
  });
}

/* ---------------------------------------------------------------------- */
/* Reads                                                                   */
/* ---------------------------------------------------------------------- */

function assertReader(identity: RequestIdentity): 'staff' | 'partner' {
  requireUserId(identity);
  if (isStaff(identity)) {
    assertAllowed(authorizeStaff(identity.actor, 'finance.read', { type: 'partner_invoice' }));
    return 'staff';
  }
  if (identity.actor.isPartner) return 'partner';
  throw new ApiError('forbidden', 'partner invoices are visible to the partner and finance only');
}

async function loadRow(tx: Transaction, id: string, lock = false): Promise<PayoutRow> {
  const q = tx
    .select()
    .from(schema.payouts)
    .where(and(eq(schema.payouts.id, id), eq(schema.payouts.kind, PARTNER_INVOICE_KIND)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new ApiError('not_found', 'partner invoice not found');
  return row;
}

export async function getPartnerInvoice(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  const reader = assertReader(identity);
  const userId = requireUserId(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, (tx) =>
    elevated(tx, ctx, async () => {
      const row = await loadRow(tx, id);
      if (reader === 'partner' && row.proposedBy !== userId)
        throw new ApiError('not_found', 'partner invoice not found');
      return toDto(tx, row);
    }),
  );
}

export async function listPartnerInvoices(
  identity: RequestIdentity,
  query: PartnerInvoiceListQuery,
  options: ServiceOptions = {},
): Promise<Page<PartnerInvoiceDto>> {
  const reader = assertReader(identity);
  const userId = requireUserId(identity);
  const cursor = decodeCursor(query.cursor);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, (tx) =>
    elevated(tx, ctx, async () => {
      const rows = await tx
        .select()
        .from(schema.payouts)
        .where(
          and(
            eq(schema.payouts.kind, PARTNER_INVOICE_KIND),
            reader === 'partner'
              ? eq(schema.payouts.proposedBy, userId)
              : query.partnerUserId
                ? eq(schema.payouts.proposedBy, query.partnerUserId)
                : undefined,
            reader === 'staff' && query.organizationId
              ? eq(schema.payouts.organizationId, query.organizationId)
              : undefined,
            query.status ? eq(schema.payouts.status, query.status) : undefined,
            cursor
              ? or(
                  lt(schema.payouts.createdAt, cursor.createdAt),
                  and(
                    eq(schema.payouts.createdAt, cursor.createdAt),
                    lt(schema.payouts.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(schema.payouts.createdAt), desc(schema.payouts.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items: PartnerInvoiceDto[] = [];
      for (const row of page) items.push(await toDto(tx, row));
      const last = rows.length > query.limit ? page[page.length - 1] : null;
      return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
    }),
  );
}

/* ---------------------------------------------------------------------- */
/* Finance transitions                                                     */
/* ---------------------------------------------------------------------- */

interface Step {
  to: PayoutStatus;
  permission: StaffPermission;
  actor: ActorKind;
  action: string;
  reason?: string | null;
  patch: (
    row: PayoutRow,
    json: PartnerInvoiceJson,
    tx: Transaction,
  ) => Promise<Partial<typeof schema.payouts.$inferInsert>>;
}

async function step(
  identity: RequestIdentity,
  id: string,
  s: Step,
  options: ServiceOptions,
): Promise<PartnerInvoiceDto> {
  const userId = requireUserId(identity);
  if (!isStaff(identity)) throw new ApiError('forbidden', 'finance staff action');
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const row = await loadRow(tx, id, true);
    const json = parseJson(row);
    assertAllowed(authorizeStaff(identity.actor, s.permission, ref(row, json)));
    const decision = evaluateTransition(payoutMachine, {
      from: row.status,
      to: s.to,
      actor: s.actor,
      reason: s.reason ?? null,
    });
    if (!decision.ok)
      throw new ApiError('invalid_transition', decision.message, {
        details: { code: decision.code },
      });
    const patch = await s.patch(row, json, tx);
    const now = new Date().toISOString();
    const nextJson: PartnerInvoiceJson = {
      ...json,
      ...((patch.beneficiary as Partial<PartnerInvoiceJson> | undefined) ?? {}),
      history: [
        ...json.history,
        { at: now, action: s.action, byUserId: userId, note: s.reason ?? null },
      ],
    };
    const [updated] = await tx
      .update(schema.payouts)
      .set({ ...patch, status: s.to, beneficiary: nextJson })
      .where(and(eq(schema.payouts.id, id), eq(schema.payouts.status, row.status)))
      .returning();
    if (!updated) throw new ApiError('conflict', 'partner invoice changed concurrently');
    const { beneficiary: _b, ...auditPatch } = patch;
    await recordAudit(tx, identity, {
      action: `partner_invoice.${s.action}`,
      entityType: 'partner_invoice',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: s.to, ...auditPatch },
      reason: s.reason ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'partner_invoice.transitioned',
      aggregateType: 'partner_invoice',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: userId,
      payload: {
        partnerInvoiceId: id,
        from: row.status,
        to: s.to,
        action: s.action,
        partnerUserId: json.partnerUserId,
        recipientUserIds: [json.partnerUserId],
      },
      correlationId: options.correlationId ?? null,
    });
    return toDto(tx, updated);
  });
}

function postingInput(row: PayoutRow, json: PartnerInvoiceJson, status: PayoutStatus) {
  return {
    payout: {
      id: row.id,
      organizationId: row.organizationId,
      currency: row.currency,
      amountKobo: row.amountKobo,
      status,
      partnerUserId: json.partnerUserId,
      partnerOrganizationId: json.partnerOrganizationId,
      reference: json.reference,
    },
    source: { type: json.source.type, id: json.source.id },
  };
}

/** Finance accepts the invoice (first approval): the payable is posted and a second approver must still authorise payment. */
export function acceptPartnerInvoice(
  identity: RequestIdentity,
  id: string,
  input: { note?: string },
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'first_approved',
      permission: 'finance.payouts.first_approve',
      actor: 'staff',
      action: 'accepted',
      reason: input.note ?? null,
      patch: async (row, json, tx) => {
        const at = new Date();
        const posted = await elevated(tx, ctxFor(identity, options), () =>
          postJournal(tx, partnerInvoiceAccepted(postingInput(row, json, 'first_approved')), {
            postedBy: userId,
          }),
        );
        return {
          firstApproverId: userId,
          firstApprovedAt: at,
          journalId: posted.id,
          failureReason: null,
          beneficiary: {
            review: {
              decision: 'accepted',
              reason: input.note ?? null,
              byUserId: userId,
              at: at.toISOString(),
            },
          } as never,
        };
      },
    },
    options,
  );
}

/** Finance rejects with a reason; an already posted payable is reversed. */
export function rejectPartnerInvoice(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'rejected',
      permission: 'finance.payouts.first_approve',
      actor: 'staff',
      action: 'rejected',
      reason: input.reason,
      patch: async (row, json, tx) => {
        if (row.journalId) {
          await elevated(tx, ctxFor(identity, options), () =>
            postJournal(
              tx,
              partnerInvoiceAcceptanceReversed(postingInput(row, json, 'first_approved'), input.reason),
              { postedBy: userId },
            ),
          );
        }
        return {
          failureReason: input.reason,
          beneficiary: {
            review: {
              decision: 'rejected',
              reason: input.reason,
              byUserId: userId,
              at: new Date().toISOString(),
            },
          } as never,
        };
      },
    },
    options,
  );
}

/** Second approval by a different finance approver; nothing is posted, payment is now authorised. */
export function secondApprovePartnerInvoice(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'approved',
      permission: 'finance.payouts.second_approve',
      actor: 'staff',
      action: 'second_approved',
      patch: async (row) => {
        if (row.firstApproverId === userId)
          throw new ApiError('forbidden', 'second approval must come from a different approver');
        return { secondApproverId: userId, secondApprovedAt: new Date() };
      },
    },
    options,
  );
}

/** Finance records that the transfer instruction went to the bank. */
export function submitPartnerInvoicePayment(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  return step(
    identity,
    id,
    {
      to: 'submitted',
      permission: 'finance.reconcile',
      actor: 'system',
      action: 'payment_submitted',
      patch: async () => ({ submittedAt: new Date() }),
    },
    options,
  );
}

/** Finance confirms the transfer on the bank statement: Dr 2400 / Cr 1000. */
export function settlePartnerInvoice(
  identity: RequestIdentity,
  id: string,
  input: { settlementReference: string },
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'settled',
      permission: 'finance.reconcile',
      actor: 'system',
      action: 'settled',
      reason: input.settlementReference,
      patch: async (row, _json, tx) => {
        await elevated(tx, ctxFor(identity, options), () =>
          postJournal(
            tx,
            ownerPayoutSettled({
              payout: {
                id: row.id,
                organizationId: row.organizationId,
                currency: row.currency,
                amountKobo: row.amountKobo,
                status: 'submitted',
              },
              settlementReference: input.settlementReference,
            }),
            { postedBy: userId },
          ),
        );
        return { settledAt: new Date(), failureReason: null };
      },
    },
    options,
  );
}

export function failPartnerInvoicePayment(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<PartnerInvoiceDto> {
  return step(
    identity,
    id,
    {
      to: 'failed',
      permission: 'finance.reconcile',
      actor: 'system',
      action: 'payment_failed',
      reason: input.reason,
      patch: async () => ({ failureReason: input.reason }),
    },
    options,
  );
}
