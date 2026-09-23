import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { assertAppendOnly, parseNegotiationLog } from '@simplexd/domain/purchase';
import {
  cleanupSearchFixture,
  createSearchFixture,
  customerA,
  customerB,
  errorCode,
  insertCleanFile,
  insertListing,
  staff,
  type SearchFixture,
} from '@/server/search/testing/fixtures';
import { addShortlistItem, createShortlist, updateShortlist } from '@/server/search/shortlists';
import {
  acknowledgeHandover,
  createPurchaseItem,
  getClosingReadiness,
  getPurchaseWorkspace,
  linkDiligence,
  prepareClosingPack,
  updatePurchaseItem,
  waiveDiligence,
} from './closing';
import { applyPurchaseOfferAction, createPurchaseOffer, getPurchaseOffer } from './offers';

/**
 * Purchase representation (brief §8): offers with an append-only negotiation
 * log and a strict state machine, conditions, the diligence dependency that
 * blocks closing, the closing checklist, document handover acknowledged by
 * the customer, the agreed fee basis and the closing pack. Every id is
 * checked across organisations.
 */

let f: SearchFixture;

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => errorCode(e),
  );

const blockerCodes = async (identity: Parameters<typeof getClosingReadiness>[0]) =>
  (await getClosingReadiness(identity, f.purchaseA)).blockers.map((b) => b.code);

beforeAll(async () => {
  f = await createSearchFixture();
});

afterAll(async () => {
  await cleanupSearchFixture(f);
});

describe('offers and the negotiation log', () => {
  let offerId = '';
  let shortlistItemId = '';

  it('drafts an offer on a shortlisted property (one live offer per request)', async () => {
    const listingId = await insertListing(f, {
      title: 'Plot 5, Ibeju-Lekki',
      propertyKind: 'land',
    });
    const sl = await createShortlist(staff(f.pm, 'project_manager'), f.purchaseA, {
      name: 'Targets',
    });
    const item = await addShortlistItem(staff(f.pm, 'project_manager'), sl.id, { listingId });
    shortlistItemId = item.id;
    await updateShortlist(staff(f.pm, 'project_manager'), sl.id, {
      status: 'shared',
      expectedUpdatedAt: sl.updatedAt,
    });
    // Offers belong to purchase representation, not to a search request.
    expect(
      await code(
        createPurchaseOffer(customerA(f), f.searchA, {
          shortlistItemId,
          amountKobo: '1',
          conditions: [],
        }),
      ),
    ).toBe('not_found');
    const offer = await createPurchaseOffer(customerA(f), f.purchaseA, {
      shortlistItemId,
      amountKobo: (42_000_000n * 100n).toString(),
      conditions: ['Subject to survey', 'Subject to registry search'],
      note: 'Opening position',
    });
    offerId = offer.id;
    expect(offer).toMatchObject({
      status: 'draft',
      subjectTitle: 'Plot 5, Ibeju-Lekki',
      entries: 1,
      listingId,
    });
    expect(offer.negotiationLog[0]).toMatchObject({
      action: 'drafted',
      byUserId: f.ownerA,
      note: 'Opening position',
    });
    expect(
      await code(
        createPurchaseOffer(customerA(f), f.purchaseA, {
          shortlistItemId,
          amountKobo: '100',
          conditions: [],
        }),
      ),
    ).toBe('conflict');
    // Another organisation and an unassigned project manager cannot see it.
    expect(await code(getPurchaseOffer(customerB(f), offerId))).toBe('not_found');
    expect(await code(getPurchaseOffer(staff(f.otherPm, 'project_manager'), offerId))).toBe(
      'forbidden',
    );
    expect(await code(getPurchaseWorkspace(customerB(f), f.purchaseA))).toBe('not_found');
  });

  it('rejects invalid transitions and wrong actors', async () => {
    // The seller's acceptance cannot be recorded on a draft; customers do not record the seller's side.
    expect(
      await code(
        applyPurchaseOfferAction(staff(f.pm, 'project_manager'), offerId, {
          action: 'accept',
          expectedEntries: 1,
        }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        applyPurchaseOfferAction(customerA(f), offerId, {
          action: 'counter',
          amountKobo: '1',
          expectedEntries: 1,
        }),
      ),
    ).toBe('forbidden');
    // Staff acting for the buyer must cite the customer's instruction.
    expect(
      await code(
        applyPurchaseOfferAction(staff(f.pm, 'project_manager'), offerId, {
          action: 'submit',
          expectedEntries: 1,
        }),
      ),
    ).toBe('validation_failed');
    // An adviser lacks the authority to commit the organisation.
    expect(
      await code(
        applyPurchaseOfferAction(
          {
            ...customerA(f),
            actor: {
              ...customerA(f).actor,
              memberships: [{ organizationId: f.orgA, role: 'adviser' }],
            },
          },
          offerId,
          { action: 'submit', expectedEntries: 1 },
        ),
      ),
    ).toBe('forbidden');
  });

  it('runs the negotiation with an append-only log and concurrency on the log length', async () => {
    const submitted = await applyPurchaseOfferAction(customerA(f), offerId, {
      action: 'submit',
      expectedEntries: 1,
    });
    expect(submitted.status).toBe('submitted');
    expect(submitted.entries).toBe(2);
    // Stale log length: conflict.
    expect(
      await code(
        applyPurchaseOfferAction(staff(f.pm, 'project_manager'), offerId, {
          action: 'counter',
          amountKobo: '1',
          expectedEntries: 1,
        }),
      ),
    ).toBe('version_conflict');
    // A counter-offer needs an amount.
    expect(
      await code(
        applyPurchaseOfferAction(staff(f.pm, 'project_manager'), offerId, {
          action: 'counter',
          expectedEntries: 2,
        }),
      ),
    ).toBe('validation_failed');
    const countered = await applyPurchaseOfferAction(staff(f.pm, 'project_manager'), offerId, {
      action: 'counter',
      amountKobo: (46_000_000n * 100n).toString(),
      note: 'Seller wants 46m',
      expectedEntries: 2,
    });
    expect(countered).toMatchObject({
      status: 'countered',
      amountKobo: (46_000_000n * 100n).toString(),
      entries: 3,
    });
    const noted = await applyPurchaseOfferAction(customerA(f), offerId, {
      action: 'note',
      note: 'Thinking about it',
      expectedEntries: 3,
    });
    expect(noted.status).toBe('countered');
    const accepted = await applyPurchaseOfferAction(customerA(f), offerId, {
      action: 'accept',
      expectedEntries: 4,
    });
    expect(accepted).toMatchObject({ status: 'accepted', entries: 5 });
    expect(accepted.decidedAt).not.toBeNull();
    // Earlier entries are byte-for-byte unchanged and the stored log agrees.
    expect(accepted.negotiationLog.slice(0, 2)).toEqual(submitted.negotiationLog);
    expect(accepted.negotiationLog.slice(0, 3)).toEqual(countered.negotiationLog);
    const [row] = await f.dbs.owner
      .select()
      .from(schema.offers)
      .where(eq(schema.offers.id, offerId));
    const stored = parseNegotiationLog(row!.negotiationLog);
    expect(stored.map((e) => e.action)).toEqual([
      'drafted',
      'submitted',
      'countered',
      'note',
      'accepted',
    ]);
    expect(() => assertAppendOnly(stored, [...stored.slice(0, 4)])).toThrow(/cannot be removed/);
    expect(() =>
      assertAppendOnly(stored, [{ ...stored[0]!, amountKobo: '1' }, ...stored.slice(1)]),
    ).toThrow(/cannot be changed/);
    // Terminal: nothing more, not even a withdrawal.
    expect(
      await code(
        applyPurchaseOfferAction(customerA(f), offerId, {
          action: 'withdraw',
          note: 'changed my mind',
          expectedEntries: 5,
        }),
      ),
    ).toBe('invalid_transition');
    // The accepted terms became tracked conditions.
    const ws = await getPurchaseWorkspace(customerA(f), f.purchaseA);
    expect(ws.conditions.map((c) => c.title).sort()).toEqual([
      'Subject to registry search',
      'Subject to survey',
    ]);
    expect(ws.conditions.every((c) => c.offerId === offerId && c.status === 'open')).toBe(true);
  });
});

describe('diligence dependency, conditions, checklist, handover and closing', () => {
  let redFlagId = '';
  let handoverId = '';
  let taskId = '';

  it('blocks closing until the diligence request is linked and clear', async () => {
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).toEqual(
      expect.arrayContaining(['conditions_open', 'diligence_not_linked', 'fee_basis_not_agreed']),
    );
    // Only a due-diligence request of the same customer can be linked.
    expect(
      await code(
        linkDiligence(staff(f.pm, 'project_manager'), f.purchaseA, {
          diligenceRequestId: f.searchB,
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await code(
        linkDiligence(staff(f.pm, 'project_manager'), f.purchaseA, {
          diligenceRequestId: f.searchA,
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await code(linkDiligence(customerA(f), f.purchaseA, { diligenceRequestId: f.diligenceA })),
    ).toBe('forbidden');
    const linked = await linkDiligence(staff(f.pm, 'project_manager'), f.purchaseA, {
      diligenceRequestId: f.diligenceA,
    });
    expect(linked.linked).toBe(true);
    expect(linked.clear).toBe(false);
    expect(linked.blockers.map((b) => b.code)).toEqual(['diligence_memo_not_released']);
    // An internal red flag on the diligence request blocks closing (and the customer is told, without counts).
    const [flag] = await f.dbs.owner
      .insert(schema.engagementItems)
      .values({
        organizationId: f.orgA,
        serviceRequestId: f.diligenceA,
        kind: 'red_flag',
        title: 'Survey plan does not match',
        severity: 'high',
        visibility: 'internal',
        createdBy: f.pm,
      })
      .returning({ id: schema.engagementItems.id });
    redFlagId = flag!.id;
    const customerView = await getPurchaseWorkspace(customerA(f), f.purchaseA);
    expect(customerView.diligence.openRedFlags).toBeNull();
    expect(customerView.diligence.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['diligence_red_flags_open', 'diligence_memo_not_released']),
    );
    const staffView = await getPurchaseWorkspace(staff(f.ops, 'operations_manager'), f.purchaseA);
    expect(staffView.diligence.openRedFlags).toBe(1);
    expect(staffView.readiness.blockers.map((b) => b.code)).toContain('diligence_red_flags_open');
  });

  it('clears the dependency once red flags are resolved or waived and the memo is released', async () => {
    await f.dbs.owner
      .update(schema.engagementItems)
      .set({
        status: 'waived',
        resolvedAt: new Date(),
        resolvedBy: f.pm,
        resolutionNote: 'Re-survey confirmed',
      })
      .where(eq(schema.engagementItems.id, redFlagId));
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).not.toContain(
      'diligence_red_flags_open',
    );
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).toContain(
      'diligence_memo_not_released',
    );
    await f.dbs.owner.insert(schema.reports).values({
      organizationId: f.orgA,
      serviceRequestId: f.diligenceA,
      kind: 'diligence_memo',
      title: 'Decision memorandum',
      status: 'released',
      currentVersion: 1,
      releasedVersion: 1,
      releasedAt: new Date(),
      releasedBy: f.reviewer,
      customerVisible: true,
      namedReviewerUserId: f.reviewer,
      createdBy: f.pm,
    });
    const codes = await blockerCodes(staff(f.pm, 'project_manager'));
    expect(codes.filter((c) => c.startsWith('diligence'))).toEqual([]);
    // Waiving needs the override permission; the reason is shown to the customer.
    expect(
      await code(
        waiveDiligence(staff(f.pm, 'project_manager'), f.purchaseA, {
          reason: 'Customer instructed us to proceed',
        }),
      ),
    ).toBe('forbidden');
    const waived = await waiveDiligence(staff(f.ops, 'operations_manager'), f.purchaseA, {
      reason: 'Customer instructed us to proceed without a memo',
    });
    expect(waived).toMatchObject({ waived: true, clear: true });
    expect(
      (await getPurchaseWorkspace(customerA(f), f.purchaseA)).diligence.waiverReason,
    ).toContain('instructed');
    // Relinking restores the live evaluation (still clear here).
    const relinked = await linkDiligence(staff(f.pm, 'project_manager'), f.purchaseA, {
      diligenceRequestId: f.diligenceA,
    });
    expect(relinked).toMatchObject({ waived: false, clear: true, memoReleased: true });
  });

  it('tracks conditions, closing tasks and customer-acknowledged handover documents', async () => {
    const ws = await getPurchaseWorkspace(staff(f.pm, 'project_manager'), f.purchaseA);
    for (const c of ws.conditions) {
      // Waiving needs a reason; satisfying does not.
      expect(
        await code(
          updatePurchaseItem(staff(f.pm, 'project_manager'), c.id, {
            status: 'waived',
            expectedVersion: c.version,
          }),
        ),
      ).toBe('invalid_transition');
    }
    const [survey, registry] = ws.conditions;
    await updatePurchaseItem(staff(f.pm, 'project_manager'), survey!.id, {
      status: 'satisfied',
      expectedVersion: survey!.version,
    });
    const waivedCondition = await updatePurchaseItem(staff(f.pm, 'project_manager'), registry!.id, {
      status: 'waived',
      reason: 'Registry search already covered by the diligence memorandum',
      expectedVersion: registry!.version,
    });
    expect(waivedCondition.resolutionNote).toContain('already covered');
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).not.toContain('conditions_open');
    // Customers cannot create or move items.
    expect(
      await code(
        createPurchaseItem(customerA(f), f.purchaseA, {
          kind: 'closing_task',
          title: 'x',
          visibility: 'customer',
          fileIds: [],
        }),
      ),
    ).toBe('forbidden');
    const task = await createPurchaseItem(staff(f.pm, 'project_manager'), f.purchaseA, {
      kind: 'closing_task',
      title: 'Pay stamp duty',
      visibility: 'customer',
      fileIds: [],
    });
    taskId = task.id;
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).toContain('closing_tasks_open');
    const fileId = await insertCleanFile(f, {
      ownerUserId: f.pm,
      organizationId: f.orgA,
      entityId: f.purchaseA,
      name: 'deed.pdf',
    });
    const handover = await createPurchaseItem(staff(f.pm, 'project_manager'), f.purchaseA, {
      kind: 'handover_document',
      title: 'Deed of assignment',
      visibility: 'customer',
      fileIds: [fileId],
    });
    handoverId = handover.id;
    expect(handover.files.map((x) => x.name)).toEqual(['deed.pdf']);
    expect(handover.acknowledged).toBe(false);
    // Staff cannot mark a handover satisfied; the customer acknowledges receipt.
    expect(
      await code(
        updatePurchaseItem(staff(f.pm, 'project_manager'), handoverId, {
          status: 'satisfied',
          expectedVersion: handover.version,
        }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        acknowledgeHandover(customerB(f), handoverId, { expectedVersion: handover.version }),
      ),
    ).toBe('not_found');
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).toContain(
      'handover_not_acknowledged',
    );
    const acknowledged = await acknowledgeHandover(customerA(f), handoverId, {
      expectedVersion: handover.version,
    });
    expect(acknowledged).toMatchObject({ status: 'satisfied', acknowledged: true });
    expect(acknowledged.resolvedByName).toContain(f.ownerA);
    const [ack] = await f.dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'purchase_handover.acknowledged'),
          eq(schema.outboxEvents.aggregateId, handoverId),
        ),
      );
    expect(ack).toBeDefined();
    await updatePurchaseItem(staff(f.pm, 'project_manager'), taskId, {
      status: 'satisfied',
      expectedVersion: task.version,
    });
    expect(await blockerCodes(staff(f.pm, 'project_manager'))).toEqual(['fee_basis_not_agreed']);
  });

  it('prepares the closing pack only with an agreed fee basis, as a reviewed report', async () => {
    const ws = await getPurchaseWorkspace(staff(f.pm, 'project_manager'), f.purchaseA);
    expect(
      await code(
        prepareClosingPack(staff(f.pm, 'project_manager'), f.purchaseA, {
          expectedVersion: ws.serviceRequestVersion,
        }),
      ),
    ).toBe('insufficient_evidence');
    const scopeFile = await insertCleanFile(f, {
      ownerUserId: f.ownerA,
      organizationId: f.orgA,
      entityId: f.purchaseA,
      name: 'signed-scope.pdf',
    });
    await f.dbs.owner
      .update(schema.serviceRequests)
      .set({
        feeBasis: {
          percentageBps: 150,
          basisAmountKobo: (46_000_000n * 100n).toString(),
          basisDescription: 'agreed purchase price of Plot 5',
          signedScopeFileId: scopeFile,
          agreedAt: new Date().toISOString(),
        } as never,
      })
      .where(eq(schema.serviceRequests.id, f.purchaseA));
    const ready = await getPurchaseWorkspace(staff(f.pm, 'project_manager'), f.purchaseA);
    expect(ready.readiness).toEqual({ ready: true, blockers: [] });
    expect(ready.feeBasis.feeKobo).toBe((690_000n * 100n).toString());
    expect(
      await code(
        prepareClosingPack(customerA(f), f.purchaseA, {
          expectedVersion: ready.serviceRequestVersion,
        }),
      ),
    ).toBe('forbidden');
    expect(
      await code(
        prepareClosingPack(staff(f.pm, 'project_manager'), f.purchaseA, {
          expectedVersion: ready.serviceRequestVersion + 5,
        }),
      ),
    ).toBe('version_conflict');
    const pack = await prepareClosingPack(staff(f.pm, 'project_manager'), f.purchaseA, {
      expectedVersion: ready.serviceRequestVersion,
      note: 'All conditions cleared; keys handed over on site.',
    });
    expect(pack).toMatchObject({
      kind: 'closing_pack',
      status: 'draft',
      serviceRequestId: f.purchaseA,
    });
    const revision = pack.revisions[0]!;
    expect(revision.bodyMarkdown).toContain('## Documents handed over');
    expect(revision.bodyMarkdown).toContain('deed.pdf');
    expect(revision.bodyMarkdown).toContain('1.50% of agreed purchase price of Plot 5');
    const after = await getPurchaseWorkspace(customerA(f), f.purchaseA);
    // Until released by a reviewer the customer sees no closing record; staff see it as submitted.
    expect(after.closing).toEqual([]);
    const staffAfter = await getPurchaseWorkspace(staff(f.ops, 'operations_manager'), f.purchaseA);
    expect(staffAfter.closing[0]).toMatchObject({
      stage: 'submitted',
      reportId: pack.id,
      acceptedOfferId: expect.any(String),
    });
    expect(staffAfter.closing[0]!.handedOverDocuments.map((d) => d.title)).toEqual([
      'Deed of assignment',
    ]);
    expect(
      await code(
        prepareClosingPack(staff(f.pm, 'project_manager'), f.purchaseA, {
          expectedVersion: ready.serviceRequestVersion,
        }),
      ),
    ).toBe('conflict');
  });
});
