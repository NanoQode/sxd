import 'server-only';
import { and, desc, eq, inArray, lt, ne, or } from 'drizzle-orm';
import { ApiError, type Page, type PayoutDto, type PayoutPropose } from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { postJournal } from '@simplexd/finance';
import {
  assertAllowed,
  authorizeAny,
  authorizeStaff,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import { ownerDistributionApproved, ownerPayoutSettled } from '@simplexd/domain/ledger';
import { evaluateTransition, payoutMachine, type ActorKind } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { loadStatementForPayout } from './owner-statements';
import {
  ctxFor,
  decodeCursor,
  elevated,
  encodeCursor,
  isStaffIdentity,
  iso,
  requireUserId,
  type ServiceOptions,
} from './shared';

/**
 * Owner distributions: proposed from a reconciled statement, approved by two
 * different finance approvers (`finance.payouts.first_approve`, then
 * `finance.payouts.second_approve` by someone else; both step-up gated by
 * the policy), which posts `Dr 2100 / Cr 2400`; finance then submits the
 * transfer and settles it against the bank statement (`Dr 2400 / Cr 1000`).
 * Nothing leaves the bank before the second approval and the reconciliation.
 */

type PayoutRow = typeof schema.payouts.$inferSelect;

function toDto(row: PayoutRow): PayoutDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    amountKobo: row.amountKobo.toString(),
    currency: row.currency,
    status: row.status,
    beneficiary: (row.beneficiary as Record<string, unknown> | null) ?? null,
    ownerStatementId: row.ownerStatementId,
    reconciliationId: row.reconciliationId,
    proposedBy: row.proposedBy,
    firstApproverId: row.firstApproverId,
    firstApprovedAt: iso(row.firstApprovedAt),
    secondApproverId: row.secondApproverId,
    secondApprovedAt: iso(row.secondApprovedAt),
    submittedAt: iso(row.submittedAt),
    settledAt: iso(row.settledAt),
    failureReason: row.failureReason,
    journalId: row.journalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ref(row: PayoutRow): ResourceRef {
  return {
    type: 'payout',
    id: row.id,
    organizationId: row.organizationId,
    createdBy: row.proposedBy,
    attributes: { firstApproverId: row.firstApproverId },
  };
}

async function load(tx: DbExecutor, id: string): Promise<PayoutRow> {
  const [row] = await tx
    .select()
    .from(schema.payouts)
    .where(eq(schema.payouts.id, id))
    .for('update');
  if (!row) throw new ApiError('not_found', 'payout not found');
  return row;
}

export async function proposePayout(
  identity: RequestIdentity,
  input: PayoutPropose,
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  const userId = requireUserId(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { row: statement, reconciliationId } = await loadStatementForPayout(
      tx,
      input.ownerStatementId,
    );
    assertAllowed(
      authorizeAny(
        identity.actor,
        [{ staff: 'rentals.manage' }, { staff: 'finance.payouts.first_approve' }],
        { type: 'payout', organizationId: statement.organizationId },
      ),
    );
    if (!['reconciled', 'issued'].includes(statement.status) || !reconciliationId)
      throw new ApiError(
        'invalid_transition',
        'payouts are proposed from a reconciled statement only',
      );
    const net = BigInt(statement.totals?.netKobo ?? '0');
    const amount = input.amountKobo ? BigInt(input.amountKobo) : net;
    if (amount <= 0n)
      throw new ApiError('validation_failed', 'nothing is payable on this statement');
    const committed = (
      await tx
        .select({ amountKobo: schema.payouts.amountKobo })
        .from(schema.payouts)
        .where(
          and(
            eq(schema.payouts.ownerStatementId, statement.id),
            inArray(schema.payouts.status, [
              'proposed',
              'first_approved',
              'approved',
              'submitted',
              'settled',
            ]),
          ),
        )
    ).reduce((s, p) => s + p.amountKobo, 0n);
    if (committed + amount > net)
      throw new ApiError('validation_failed', 'payout exceeds the statement net payable', {
        details: { netKobo: net.toString(), alreadyProposedKobo: committed.toString() },
      });
    const [row] = await tx
      .insert(schema.payouts)
      .values({
        organizationId: statement.organizationId,
        kind: 'owner_distribution',
        amountKobo: amount,
        currency: 'NGN',
        status: 'proposed',
        beneficiary: input.beneficiary,
        ownerStatementId: statement.id,
        reconciliationId,
        proposedBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'payout.proposed',
      entityType: 'payout',
      entityId: row!.id,
      organizationId: statement.organizationId,
      after: { amountKobo: amount, ownerStatementId: statement.id, beneficiary: input.beneficiary },
      correlationId: options.correlationId,
    });
    return toDto(row!);
  });
}

interface Step {
  to: PayoutRow['status'];
  permission: StaffPermission;
  actor: ActorKind;
  reason?: string | null;
  patch: (row: PayoutRow, tx: Transaction) => Promise<Partial<typeof schema.payouts.$inferInsert>>;
}

async function step(
  identity: RequestIdentity,
  id: string,
  s: Step,
  options: ServiceOptions,
): Promise<PayoutDto> {
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const row = await load(tx, id);
    assertAllowed(authorizeStaff(identity.actor, s.permission, ref(row)));
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
    const patch = await s.patch(row, tx);
    const [updated] = await tx
      .update(schema.payouts)
      .set({ status: s.to, ...patch })
      .where(and(eq(schema.payouts.id, id), eq(schema.payouts.status, row.status)))
      .returning();
    if (!updated) throw new ApiError('conflict', 'payout changed concurrently');
    await recordAudit(tx, identity, {
      action: `payout.${s.to}`,
      entityType: 'payout',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: s.to, ...patch },
      reason: s.reason ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'payout.transitioned',
      aggregateType: 'payout',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: identity.session?.user.id ?? null,
      payload: { payoutId: id, from: row.status, to: s.to, amountKobo: row.amountKobo.toString() },
      correlationId: options.correlationId ?? null,
    });
    return toDto(updated);
  });
}

export function firstApprovePayout(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'first_approved',
      permission: 'finance.payouts.first_approve',
      actor: 'staff',
      patch: async (row, tx) => {
        if (row.proposedBy === userId)
          throw new ApiError('forbidden', 'the proposer cannot give the first approval');
        await assertReconciliationBalanced(tx, row);
        return { firstApproverId: userId, firstApprovedAt: new Date() };
      },
    },
    options,
  );
}

async function assertReconciliationBalanced(
  tx: DbExecutor,
  row: PayoutRow,
): Promise<{ id: string; status: (typeof schema.reconciliations.$inferSelect)['status'] }> {
  if (!row.reconciliationId)
    throw new ApiError('invalid_transition', 'payout has no reconciliation');
  const [rec] = await tx
    .select({ id: schema.reconciliations.id, status: schema.reconciliations.status })
    .from(schema.reconciliations)
    .where(eq(schema.reconciliations.id, row.reconciliationId));
  if (!rec || !['balanced', 'closed'].includes(rec.status))
    throw new ApiError('invalid_transition', 'payouts require a balanced reconciliation');
  return rec;
}

/** Second approval by a different approver posts the distribution (`payout:<id>:approved`). */
export function secondApprovePayout(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'approved',
      permission: 'finance.payouts.second_approve',
      actor: 'staff',
      patch: async (row, tx) => {
        if (row.firstApproverId === userId)
          throw new ApiError('forbidden', 'second approval must come from a different approver');
        const rec = await assertReconciliationBalanced(tx, row);
        const [statement] = row.ownerStatementId
          ? await tx
              .select({ estateId: schema.ownerStatements.estateId })
              .from(schema.ownerStatements)
              .where(eq(schema.ownerStatements.id, row.ownerStatementId))
          : [];
        const estateSegment = statement?.estateId
          ? ((
              await tx
                .select({ s: schema.estates.ledgerSegment })
                .from(schema.estates)
                .where(eq(schema.estates.id, statement.estateId))
            )[0]?.s ?? null)
          : null;
        const journalId = await elevated(tx, ctxFor(identity, options), async () => {
          const posted = await postJournal(
            tx,
            ownerDistributionApproved({
              payout: {
                id: row.id,
                organizationId: row.organizationId,
                currency: row.currency,
                amountKobo: row.amountKobo,
                status: 'approved',
                ownerStatementId: row.ownerStatementId,
              },
              reconciliation: rec,
              estateSegment,
            }),
            { postedBy: userId },
          );
          return posted.id;
        });
        return { secondApproverId: userId, secondApprovedAt: new Date(), journalId };
      },
    },
    options,
  );
}

export function rejectPayout(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  return step(
    identity,
    id,
    {
      to: 'rejected',
      permission: 'finance.payouts.first_approve',
      actor: 'staff',
      reason: input.reason,
      patch: async () => ({ failureReason: input.reason }),
    },
    options,
  );
}

/** Finance marks the transfer as sent to the bank (no money movement is recorded yet). */
export function submitPayout(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  return step(
    identity,
    id,
    {
      to: 'submitted',
      permission: 'finance.reconcile',
      actor: 'system',
      patch: async () => ({ submittedAt: new Date() }),
    },
    options,
  );
}

/** Finance confirms the transfer on the bank statement: `payout:<id>:settled` (`Dr 2400 / Cr 1000`). */
export function settlePayout(
  identity: RequestIdentity,
  id: string,
  input: { settlementReference: string },
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  const userId = requireUserId(identity);
  return step(
    identity,
    id,
    {
      to: 'settled',
      permission: 'finance.reconcile',
      actor: 'system',
      patch: async (row, tx) => {
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

export function failPayout(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<PayoutDto> {
  return step(
    identity,
    id,
    {
      to: 'failed',
      permission: 'finance.reconcile',
      actor: 'system',
      reason: input.reason,
      patch: async () => ({ failureReason: input.reason }),
    },
    options,
  );
}

export async function getPayout(identity: RequestIdentity, id: string): Promise<PayoutDto> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [row] = await tx.select().from(schema.payouts).where(eq(schema.payouts.id, id));
    if (!row) throw new ApiError('not_found', 'payout not found');
    assertAllowed(
      authorizeAny(
        identity.actor,
        [{ staff: 'finance.read' }, { staff: 'rentals.manage' }, { org: 'org.read' }],
        ref(row),
      ),
    );
    return toDto(row);
  });
}

export async function listPayouts(
  identity: RequestIdentity,
  query: { organizationId?: string; status?: PayoutRow['status']; cursor?: string; limit: number },
): Promise<Page<PayoutDto>> {
  requireUserId(identity);
  const staff = isStaffIdentity(identity);
  const orgId = staff ? (query.organizationId ?? null) : identity.ctx.organizationId;
  if (!staff && !orgId) return { items: [], nextCursor: null };
  assertAllowed(
    authorizeAny(
      identity.actor,
      [{ staff: 'finance.read' }, { staff: 'rentals.manage' }, { org: 'org.read' }],
      { type: 'payout', organizationId: orgId },
    ),
  );
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.payouts)
      .where(
        and(
          orgId ? eq(schema.payouts.organizationId, orgId) : undefined,
          // Partner invoices (kind partner_invoice) have their own list and review flow.
          ne(schema.payouts.kind, 'partner_invoice'),
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
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: page.map(toDto),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}
