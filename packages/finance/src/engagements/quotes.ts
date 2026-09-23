import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  ApiError,
  type QuoteAccept,
  type QuoteCreate,
  type QuoteDto,
  type QuoteIssue,
  type QuoteReject,
  type QuoteVersionCreate,
  type QuoteVersionDto,
} from '@simplexd/contracts';
import { schema, withActor, type Transaction } from '@simplexd/db';
import { bpsOf } from '@simplexd/domain/money';
import {
  actorKindOf,
  assertOrg,
  assertStaff,
  assertStaffOrOrg,
  elevated,
  isStaffActor,
  requireUserId,
  systemFinanceActor,
  type FinanceActor,
} from '../actor';
import { emitEvent, recordAudit } from '../audit';
import { createInvoiceRecord, issueInvoiceTx } from '../invoices';
import { isUniqueViolation } from '../journal';
import { computeTotals, iso, loadTaxTreatment, type LineInput } from '../money';
import type { FinanceRuntime } from '../runtime';
import { loadServiceRequestForUpdate, transitionEngagement } from './transitions';

type QuoteRow = typeof schema.quotes.$inferSelect;
type QuoteVersionRow = typeof schema.quoteVersions.$inferSelect;

/** Billing terms the acceptance step applies; stored inside `quote_versions.fee_basis`. */
export interface QuoteBillingTerms {
  depositBps: number;
  requiresPayment: boolean;
  installmentPlan?: Array<{ label: string; amountKobo: string; dueDate?: string }>;
}

interface StoredFeeBasis {
  percentageBps?: number;
  basisDescription?: string;
  basisAmountKobo?: string;
  signedScopeFileId?: string;
  billing: QuoteBillingTerms;
}

export const DEFAULT_QUOTE_VALIDITY_DAYS = 14;

function toVersionDto(v: QuoteVersionRow): QuoteVersionDto {
  return {
    id: v.id,
    version: v.version,
    lines: v.lines,
    subtotalKobo: v.subtotalKobo.toString(),
    taxKobo: v.taxKobo.toString(),
    totalKobo: v.totalKobo.toString(),
    currency: v.currency,
    scopeMarkdown: v.scopeMarkdown,
    exclusions: v.exclusions,
    validUntil: iso(v.validUntil),
    feeBasis: v.feeBasis ?? null,
    taxTreatmentKey: v.taxTreatmentKey,
    issuedAt: iso(v.issuedAt),
    createdAt: v.createdAt.toISOString(),
  };
}

async function buildQuoteDto(tx: Transaction, quote: QuoteRow): Promise<QuoteDto> {
  const versions = await tx
    .select()
    .from(schema.quoteVersions)
    .where(eq(schema.quoteVersions.quoteId, quote.id))
    .orderBy(asc(schema.quoteVersions.version));
  const versionIds = versions.map((v) => v.id);
  const acceptance =
    versionIds.length === 0
      ? null
      : (
          await tx
            .select()
            .from(schema.acceptances)
            .where(inArray(schema.acceptances.quoteVersionId, versionIds))
        )[0] ?? null;
  const invoice =
    versionIds.length === 0
      ? null
      : (
          await tx
            .select({ id: schema.invoices.id })
            .from(schema.invoices)
            .where(inArray(schema.invoices.quoteVersionId, versionIds))
            .orderBy(desc(schema.invoices.createdAt))
            .limit(1)
        )[0] ?? null;
  return {
    id: quote.id,
    serviceRequestId: quote.serviceRequestId,
    organizationId: quote.organizationId,
    status: quote.status,
    currentVersion: quote.currentVersion,
    versions: versions.map(toVersionDto),
    acceptance: acceptance
      ? {
          quoteVersionId: acceptance.quoteVersionId,
          acceptedByUserId: acceptance.acceptedByUserId,
          acceptedAt: acceptance.acceptedAt.toISOString(),
          signatureName: acceptance.signatureName,
          termsVersion: acceptance.termsVersion,
        }
      : null,
    invoiceId: invoice?.id ?? null,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

async function loadQuoteForUpdate(tx: Transaction, quoteId: string): Promise<QuoteRow> {
  const [quote] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId)).for('update');
  if (!quote) throw new ApiError('not_found', 'quote not found');
  return quote;
}

async function currentVersionOf(tx: Transaction, quote: QuoteRow): Promise<QuoteVersionRow> {
  const [version] = await tx
    .select()
    .from(schema.quoteVersions)
    .where(and(eq(schema.quoteVersions.quoteId, quote.id), eq(schema.quoteVersions.version, quote.currentVersion)));
  if (!version) throw new ApiError('internal_error', 'quote has no current version');
  return version;
}

function feeBasisFor(input: QuoteVersionCreate | QuoteCreate): StoredFeeBasis {
  const billing: QuoteBillingTerms = {
    depositBps: input.depositBps,
    requiresPayment: input.requiresPayment,
  };
  if (input.installmentPlan) billing.installmentPlan = input.installmentPlan;
  return { ...(input.feeBasis ?? {}), billing };
}

/** Percentage-based fees: the lines are derived from the agreed basis amount, never typed as totals. */
function linesFromFeeBasis(input: QuoteCreate | QuoteVersionCreate): LineInput[] | null {
  const fb = input.feeBasis;
  if (!fb?.percentageBps || !fb.basisAmountKobo) return null;
  const amount = bpsOf(BigInt(fb.basisAmountKobo), fb.percentageBps);
  return [
    {
      description: `${(fb.percentageBps / 100).toFixed(2)}% of ${fb.basisDescription ?? 'the agreed basis'}`,
      quantity: '1',
      unitAmountKobo: amount.toString(),
    },
  ];
}

async function insertVersion(
  tx: Transaction,
  fa: FinanceActor,
  quote: QuoteRow,
  versionNumber: number,
  lines: LineInput[],
  input: QuoteCreate | QuoteVersionCreate,
): Promise<QuoteVersionRow> {
  const treatment = await loadTaxTreatment(tx, input.taxTreatmentKey ?? null);
  const totals = computeTotals(lines, treatment);
  if (totals.totalKobo <= 0n && input.requiresPayment) {
    throw new ApiError('validation_failed', 'a quote that requires payment must have a positive total');
  }
  const [version] = await tx
    .insert(schema.quoteVersions)
    .values({
      quoteId: quote.id,
      version: versionNumber,
      lines: totals.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitAmountKobo: l.unitAmountKobo.toString(),
        amountKobo: l.amountKobo.toString(),
        taxRateBps: l.taxRateBps,
        ...(l.accountCode ? { accountCode: l.accountCode } : {}),
      })),
      subtotalKobo: totals.subtotalKobo,
      taxKobo: totals.taxKobo,
      totalKobo: totals.totalKobo,
      currency: input.currency,
      scopeMarkdown: input.scopeMarkdown ?? null,
      exclusions: input.exclusions ?? null,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      feeBasis: feeBasisFor(input),
      taxTreatmentKey: treatment?.key ?? null,
    })
    .returning();
  await recordAudit(tx, fa, {
    action: 'quote.version_created',
    entityType: 'quote',
    entityId: quote.id,
    organizationId: quote.organizationId,
    after: {
      version: versionNumber,
      subtotalKobo: totals.subtotalKobo,
      taxKobo: totals.taxKobo,
      totalKobo: totals.totalKobo,
      taxTreatmentKey: treatment?.key ?? null,
    },
  });
  return version!;
}

/** Staff creates a draft quote (version 1) from a template or explicit lines. */
export async function createQuote(
  rt: FinanceRuntime,
  fa: FinanceActor,
  serviceRequestId: string,
  input: QuoteCreate,
): Promise<QuoteDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const sr = await loadServiceRequestForUpdate(tx, serviceRequestId);
    assertStaff(fa, 'quotes.issue', {
      type: 'service_request',
      id: sr.id,
      organizationId: sr.organizationId,
      assigneeUserIds: sr.assignedPmUserId ? [sr.assignedPmUserId] : [],
    });
    if (!['triage', 'quoted'].includes(sr.status)) {
      throw new ApiError('invalid_transition', `a quote can only be drafted for a request in triage or quoted (currently ${sr.status})`);
    }
    let lines: LineInput[] | null = linesFromFeeBasis(input);
    let scope: Pick<QuoteCreate, 'scopeMarkdown' | 'exclusions'> = input;
    if (!lines && input.templateId) {
      const [template] = await tx
        .select()
        .from(schema.quoteTemplates)
        .where(and(eq(schema.quoteTemplates.id, input.templateId), eq(schema.quoteTemplates.active, true)));
      if (!template) throw new ApiError('not_found', 'quote template not found');
      lines = template.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitAmountKobo: l.unitAmountKobo,
        ...(l.taxRateBps !== undefined ? { taxRateBps: l.taxRateBps } : {}),
        ...(l.accountCode ? { accountCode: l.accountCode } : {}),
      }));
      scope = {
        scopeMarkdown: input.scopeMarkdown ?? template.scopeMarkdown ?? undefined,
        exclusions: input.exclusions ?? template.exclusions ?? undefined,
      };
    }
    if (!lines) lines = input.lines ?? [];
    const [quote] = await tx
      .insert(schema.quotes)
      .values({
        serviceRequestId: sr.id,
        organizationId: sr.organizationId,
        status: 'draft',
        currentVersion: 1,
        createdBy: fa.actor.userId,
      })
      .returning();
    await insertVersion(tx, fa, quote!, 1, lines, { ...input, ...scope });
    await recordAudit(tx, fa, {
      action: 'quote.created',
      entityType: 'quote',
      entityId: quote!.id,
      organizationId: sr.organizationId,
      after: { serviceRequestId: sr.id, templateId: input.templateId ?? null },
    });
    return buildQuoteDto(tx, quote!);
  });
}

/** A new version supersedes the current one; the quote returns to draft until issued again. */
export async function addQuoteVersion(
  rt: FinanceRuntime,
  fa: FinanceActor,
  quoteId: string,
  input: QuoteVersionCreate,
): Promise<QuoteDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const quote = await loadQuoteForUpdate(tx, quoteId);
    assertStaff(fa, 'quotes.issue', { type: 'quote', id: quote.id, organizationId: quote.organizationId });
    if (!['draft', 'issued', 'expired', 'rejected'].includes(quote.status)) {
      throw new ApiError('invalid_transition', `quote is ${quote.status}; only draft, issued, expired or rejected quotes take a new version`);
    }
    const lines = linesFromFeeBasis(input) ?? input.lines;
    const nextVersion = quote.currentVersion + 1;
    await insertVersion(tx, fa, quote, nextVersion, lines, input);
    const [updated] = await tx
      .update(schema.quotes)
      .set({ currentVersion: nextVersion, status: 'draft' })
      .where(eq(schema.quotes.id, quote.id))
      .returning();
    return buildQuoteDto(tx, updated!);
  });
}

/** Issues the current version: quote → issued, engagement → quoted (staff `quotes.issue`). */
export async function issueQuote(
  rt: FinanceRuntime,
  fa: FinanceActor,
  quoteId: string,
  input: QuoteIssue,
): Promise<QuoteDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const quote = await loadQuoteForUpdate(tx, quoteId);
    const sr = await loadServiceRequestForUpdate(tx, quote.serviceRequestId);
    assertStaff(fa, 'quotes.issue', {
      type: 'service_request',
      id: sr.id,
      organizationId: sr.organizationId,
      assigneeUserIds: sr.assignedPmUserId ? [sr.assignedPmUserId] : [],
    });
    if (quote.status !== 'draft') {
      throw new ApiError('invalid_transition', `quote is ${quote.status}; only drafts can be issued`);
    }
    const version = await currentVersionOf(tx, quote);
    const now = rt.now();
    const validUntil = input.validUntil
      ? new Date(input.validUntil)
      : version.validUntil && version.validUntil > now
        ? version.validUntil
        : new Date(now.getTime() + (input.validDays ?? DEFAULT_QUOTE_VALIDITY_DAYS) * 86_400_000);
    if (validUntil <= now) throw new ApiError('validation_failed', 'validUntil must be in the future');
    // Older issued quotes for the same request are superseded by this one.
    await tx
      .update(schema.quotes)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(schema.quotes.serviceRequestId, sr.id),
          eq(schema.quotes.status, 'issued'),
          sql`${schema.quotes.id} <> ${quote.id}`,
        ),
      );
    await tx
      .update(schema.quoteVersions)
      .set({ issuedAt: now, issuedBy: fa.actor.userId, validUntil })
      .where(eq(schema.quoteVersions.id, version.id));
    const [updated] = await tx
      .update(schema.quotes)
      .set({ status: 'issued' })
      .where(eq(schema.quotes.id, quote.id))
      .returning();
    await transitionEngagement(tx, fa, {
      sr,
      to: 'quoted',
      metadata: { quoteId: quote.id, quoteVersionId: version.id, version: version.version, validUntil: validUntil.toISOString() },
    });
    await emitEvent(tx, fa, {
      eventType: 'quote.issued',
      aggregateType: 'quote',
      aggregateId: quote.id,
      organizationId: quote.organizationId,
      payload: {
        quoteId: quote.id,
        quoteVersionId: version.id,
        version: version.version,
        serviceRequestId: sr.id,
        reference: sr.reference,
        requestedByUserId: sr.requestedByUserId,
        totalKobo: version.totalKobo,
        validUntil: validUntil.toISOString(),
      },
    });
    await recordAudit(tx, fa, {
      action: 'quote.issued',
      entityType: 'quote',
      entityId: quote.id,
      organizationId: quote.organizationId,
      after: { version: version.version, validUntil: validUntil.toISOString(), totalKobo: version.totalKobo },
    });
    return buildQuoteDto(tx, updated!);
  });
}

export interface QuoteAcceptanceResult {
  quote: QuoteDto;
  invoiceId: string | null;
  engagementStatus: 'awaiting_payment' | 'in_progress';
}

/**
 * Customer acceptance (`org.quotes.accept`, idempotent at the HTTP layer):
 * records the acceptance (signature name, terms version, IP hash, user
 * agent), moves the quote to accepted and the engagement to accepted, then
 * issues the deposit/service invoice under the system context when the
 * quote requires payment (engagement → awaiting_payment) or starts work
 * (engagement → in_progress) when it does not.
 */
export async function acceptQuote(
  rt: FinanceRuntime,
  fa: FinanceActor,
  quoteId: string,
  input: QuoteAccept,
): Promise<QuoteAcceptanceResult> {
  const userId = requireUserId(fa);
  return withActor(rt.db, fa.ctx, async (tx) => {
    const quote = await loadQuoteForUpdate(tx, quoteId);
    assertOrg(fa, 'org.quotes.accept', { type: 'quote', id: quote.id, organizationId: quote.organizationId });
    const sr = await loadServiceRequestForUpdate(tx, quote.serviceRequestId);
    const version = await currentVersionOf(tx, quote);
    if (version.id !== input.quoteVersionId) {
      throw new ApiError('conflict', 'a newer quote version was issued; review it before accepting', {
        details: { currentVersionId: version.id, currentVersion: version.version },
      });
    }
    const now = rt.now();
    if (quote.status !== 'issued') {
      throw new ApiError('invalid_transition', `quote is ${quote.status}; only issued quotes can be accepted`);
    }
    if (version.validUntil && version.validUntil < now) {
      await tx.update(schema.quotes).set({ status: 'expired' }).where(eq(schema.quotes.id, quote.id));
      throw new ApiError('deadline_passed', 'this quote has expired; ask for a re-issued version');
    }
    try {
      await tx.insert(schema.acceptances).values({
        quoteVersionId: version.id,
        acceptedByUserId: userId,
        ipHash: fa.ipHash ?? null,
        userAgent: fa.userAgent?.slice(0, 300) ?? null,
        signatureName: input.signatureName,
        termsVersion: input.termsVersion,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'this quote version was already accepted');
      throw err;
    }
    const [accepted] = await tx
      .update(schema.quotes)
      .set({ status: 'accepted' })
      .where(eq(schema.quotes.id, quote.id))
      .returning();
    const stored = (version.feeBasis ?? {}) as Partial<StoredFeeBasis>;
    const billing: QuoteBillingTerms = stored.billing ?? { depositBps: 10_000, requiresPayment: true };
    const srAfterAccept = await transitionEngagement(tx, fa, {
      sr,
      to: 'accepted',
      actorKind: 'customer',
      patch: stored.percentageBps
        ? {
            feeBasis: {
              percentageBps: stored.percentageBps,
              ...(stored.basisDescription ? { basisDescription: stored.basisDescription } : {}),
              ...(stored.signedScopeFileId ? { signedScopeFileId: stored.signedScopeFileId } : {}),
              agreedAt: now.toISOString(),
            },
          }
        : {},
      metadata: { quoteId: quote.id, quoteVersionId: version.id, signatureName: input.signatureName, termsVersion: input.termsVersion },
    });
    await emitEvent(tx, fa, {
      eventType: 'quote.accepted',
      aggregateType: 'quote',
      aggregateId: quote.id,
      organizationId: quote.organizationId,
      payload: { quoteId: quote.id, quoteVersionId: version.id, serviceRequestId: sr.id, acceptedByUserId: userId },
    });
    await recordAudit(tx, fa, {
      action: 'quote.accepted',
      entityType: 'quote',
      entityId: quote.id,
      organizationId: quote.organizationId,
      after: { quoteVersionId: version.id, signatureName: input.signatureName, termsVersion: input.termsVersion },
    });

    const requiresPayment = billing.requiresPayment && billing.depositBps > 0 && version.totalKobo > 0n;
    // Invoice creation and the follow-on engagement transitions are system
    // actions: the invoice policy is self-referencing and journals are privileged.
    const system: FinanceActor = { ...systemFinanceActor(fa.correlationId), ipHash: fa.ipHash ?? null, userAgent: fa.userAgent ?? null };
    const result = await elevated(tx, fa, async () => {
      if (requiresPayment) {
        const isDeposit = billing.depositBps < 10_000;
        const invoiceLines: LineInput[] = isDeposit
          ? [
              {
                description: `Deposit (${(billing.depositBps / 100).toFixed(2)}%) on quote ${sr.reference} v${version.version}`,
                quantity: '1',
                unitAmountKobo: bpsOf(version.subtotalKobo, billing.depositBps).toString(),
              },
            ]
          : version.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitAmountKobo: l.unitAmountKobo,
              ...(l.taxRateBps !== undefined ? { taxRateBps: l.taxRateBps } : {}),
              ...(l.accountCode ? { accountCode: l.accountCode } : {}),
            }));
        const invoice = await createInvoiceRecord(tx, system, {
          organizationId: sr.organizationId,
          customerUserId: sr.requestedByUserId,
          kind: isDeposit ? 'deposit' : 'service',
          serviceRequestId: sr.id,
          quoteVersionId: version.id,
          lines: invoiceLines,
          currency: version.currency,
          taxTreatmentKey: version.taxTreatmentKey,
          installmentPlan: billing.installmentPlan ?? null,
          notes: `Issued on acceptance of quote ${sr.reference} v${version.version}`,
          createdBy: userId,
        });
        const issued = await issueInvoiceTx(tx, system, invoice, { now, dueDate: null });
        await transitionEngagement(tx, system, {
          sr: srAfterAccept,
          to: 'awaiting_payment',
          actorKind: 'system',
          metadata: { invoiceId: issued.id, invoiceNumber: issued.number, totalKobo: issued.totalKobo.toString() },
        });
        return { invoiceId: issued.id, engagementStatus: 'awaiting_payment' as const };
      }
      await transitionEngagement(tx, system, {
        sr: srAfterAccept,
        to: 'in_progress',
        actorKind: 'system',
        metadata: { billingConsequence: 'no_upfront_payment', quoteId: quote.id },
      });
      return { invoiceId: null, engagementStatus: 'in_progress' as const };
    });
    return { quote: await buildQuoteDto(tx, accepted!), ...result };
  });
}

/** Customer (or staff on their behalf) rejects the issued quote with a reason. */
export async function rejectQuote(
  rt: FinanceRuntime,
  fa: FinanceActor,
  quoteId: string,
  input: QuoteReject,
): Promise<QuoteDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const quote = await loadQuoteForUpdate(tx, quoteId);
    assertStaffOrOrg(fa, 'quotes.issue', 'org.quotes.accept', { type: 'quote', id: quote.id, organizationId: quote.organizationId });
    if (quote.status !== 'issued') {
      throw new ApiError('invalid_transition', `quote is ${quote.status}; only issued quotes can be rejected`);
    }
    const version = await currentVersionOf(tx, quote);
    if (version.id !== input.quoteVersionId) {
      throw new ApiError('conflict', 'a newer quote version was issued', { details: { currentVersionId: version.id } });
    }
    const sr = await loadServiceRequestForUpdate(tx, quote.serviceRequestId);
    const [updated] = await tx.update(schema.quotes).set({ status: 'rejected' }).where(eq(schema.quotes.id, quote.id)).returning();
    await transitionEngagement(tx, fa, {
      sr,
      to: 'rejected',
      reason: input.reason,
      actorKind: isStaffActor(fa) ? 'staff' : 'customer',
      metadata: { quoteId: quote.id, quoteVersionId: version.id, billingConsequence: 'none' },
    });
    await recordAudit(tx, fa, {
      action: 'quote.rejected',
      entityType: 'quote',
      entityId: quote.id,
      organizationId: quote.organizationId,
      reason: input.reason,
      after: { quoteVersionId: version.id, actorKind: actorKindOf(fa) },
    });
    return buildQuoteDto(tx, updated!);
  });
}

export async function getQuote(rt: FinanceRuntime, fa: FinanceActor, quoteId: string): Promise<QuoteDto> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [quote] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
    if (!quote) throw new ApiError('not_found', 'quote not found');
    assertStaffOrOrg(fa, 'service_requests.read_all', 'org.read', { type: 'quote', id: quote.id, organizationId: quote.organizationId });
    return buildQuoteDto(tx, quote);
  });
}

export async function listQuotesForRequest(
  rt: FinanceRuntime,
  fa: FinanceActor,
  serviceRequestId: string,
): Promise<QuoteDto[]> {
  return withActor(rt.db, fa.ctx, async (tx) => {
    const [sr] = await tx.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.id, serviceRequestId));
    if (!sr) throw new ApiError('not_found', 'request not found');
    assertStaffOrOrg(fa, 'service_requests.read_all', 'org.read', { type: 'service_request', id: sr.id, organizationId: sr.organizationId });
    const quotes = await tx
      .select()
      .from(schema.quotes)
      .where(eq(schema.quotes.serviceRequestId, sr.id))
      .orderBy(desc(schema.quotes.createdAt));
    const out: QuoteDto[] = [];
    for (const q of quotes) out.push(await buildQuoteDto(tx, q));
    return out;
  });
}

/** Scheduled: issued quotes past their validity become expired (the engagement stays quoted for re-issue). */
export async function expireQuotes(rt: FinanceRuntime, now: Date = rt.now()): Promise<string[]> {
  const system = systemFinanceActor('expire-quotes');
  return withActor(rt.db, system.ctx, async (tx) => {
    const rows = await tx
      .select({ quoteId: schema.quotes.id, organizationId: schema.quotes.organizationId, versionId: schema.quoteVersions.id })
      .from(schema.quotes)
      .innerJoin(
        schema.quoteVersions,
        and(eq(schema.quoteVersions.quoteId, schema.quotes.id), eq(schema.quoteVersions.version, schema.quotes.currentVersion)),
      )
      .where(and(eq(schema.quotes.status, 'issued'), lt(schema.quoteVersions.validUntil, now)));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.quoteId);
    await tx.update(schema.quotes).set({ status: 'expired' }).where(inArray(schema.quotes.id, ids));
    for (const row of rows) {
      await recordAudit(tx, system, {
        action: 'quote.expired',
        entityType: 'quote',
        entityId: row.quoteId,
        organizationId: row.organizationId,
        after: { quoteVersionId: row.versionId, expiredAt: now.toISOString() },
        actorType: 'job',
      });
      await emitEvent(tx, system, {
        eventType: 'quote.expired',
        aggregateType: 'quote',
        aggregateId: row.quoteId,
        organizationId: row.organizationId,
        payload: { quoteId: row.quoteId, quoteVersionId: row.versionId },
      });
    }
    return ids;
  });
}
