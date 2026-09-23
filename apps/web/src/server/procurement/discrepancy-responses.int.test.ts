import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryDto, DiscrepancyDto, PurchaseOrderDetail } from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, type TestDatabases } from '@simplexd/db/testing';
import { startPartnerConversation } from '@/server/conversations/partner';
import { errorCode } from '@/server/projects/testing/fixtures';
import { acceptDelivery, openDiscrepancy, recordDelivery } from './deliveries';
import {
  decideDiscrepancyResponse,
  listDiscrepancyThreads,
  respondToDiscrepancy,
} from './discrepancy-responses';
import {
  insertPartnerFile,
  issuedPurchaseOrderFor,
  seedChainFixture,
  type ChainFixture,
} from './testing/purchase-order-chain';

/**
 * Suppliers reply to discrepancies raised on their deliveries; staff decide.
 * A competitor never sees another supplier's discrepancy, let alone replies
 * to it; the ordering organisation reads the thread but cannot act on it.
 */

let dbs: TestDatabases;
let f: ChainFixture;
let po: PurchaseOrderDetail;
let delivery: DeliveryDto;
let discrepancy: DiscrepancyDto;

beforeAll(async () => {
  dbs = connectTestDatabases();
  f = await seedChainFixture(dbs.owner);
  po = await issuedPurchaseOrderFor(f, f.vendorA);
  delivery = await recordDelivery(f.staff, po.id, {
    deliveredAt: new Date().toISOString(),
    lines: [{ lineId: po.lines[0]!.lineId, quantityReceived: '90' }],
    evidenceFileIds: [],
    note: 'Ten bags short',
  });
  discrepancy = await openDiscrepancy(f.staff, delivery.id, {
    lineId: po.lines[0]!.lineId,
    kind: 'short_delivery',
    description: '10 bags missing from the consignment',
    quantity: '10',
  });
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

async function evidenceRowsFor(deliveryId: string) {
  return dbs.owner
    .select({ id: schema.evidence.id, fileId: schema.evidence.fileId })
    .from(schema.evidence)
    .where(eq(schema.evidence.deliveryId, deliveryId));
}

describe('supplier responses to delivery discrepancies', () => {
  it('lets only the named supplier respond, with their own scanned files, and isolates competitors', async () => {
    expect(await errorCode(listDiscrepancyThreads(f.vendorB, delivery.id))).toBe('not_found');
    expect(
      await errorCode(
        respondToDiscrepancy(f.vendorB, delivery.id, discrepancy.id, {
          response: 'Not my delivery',
          proposedResolution: 'dispute',
          evidenceFileIds: [],
        }),
      ),
    ).toBe('not_found');
    expect(await errorCode(listDiscrepancyThreads(f.stranger, delivery.id))).toBe('not_found');
    // The ordering organisation reads the thread but cannot respond.
    const customerView = await listDiscrepancyThreads(f.customer, delivery.id);
    expect(customerView.items).toHaveLength(1);
    expect(customerView.items[0]).toMatchObject({
      responseState: 'awaiting_supplier',
      canRespond: false,
      canDecide: false,
    });
    expect(
      await errorCode(
        respondToDiscrepancy(f.customer, delivery.id, discrepancy.id, {
          response: 'We saw the truck',
          proposedResolution: 'dispute',
          evidenceFileIds: [],
        }),
      ),
    ).toMatch(/not_found|forbidden/);

    const ownFile = await insertPartnerFile(dbs.owner, f.vendorAId);
    const competitorFile = await insertPartnerFile(dbs.owner, f.vendorBId);
    const scanningFile = await insertPartnerFile(dbs.owner, f.vendorAId, 'scanning');
    expect(
      await errorCode(
        respondToDiscrepancy(f.vendorA, delivery.id, discrepancy.id, {
          response: 'See the waybill',
          proposedResolution: 'dispute',
          evidenceFileIds: [competitorFile],
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await errorCode(
        respondToDiscrepancy(f.vendorA, delivery.id, discrepancy.id, {
          response: 'See the waybill',
          proposedResolution: 'dispute',
          evidenceFileIds: [scanningFile],
        }),
      ),
    ).toBe('file_quarantined');

    const thread = await respondToDiscrepancy(f.vendorA, delivery.id, discrepancy.id, {
      response: 'Ten bags were held back at the depot; we will deliver them tomorrow.',
      proposedResolution: 'replace',
      evidenceFileIds: [ownFile],
    });
    expect(thread.responseState).toBe('responded');
    // Replying proves the supplier knows: an open discrepancy becomes supplier_notified.
    expect(thread.discrepancy.status).toBe('supplier_notified');
    expect(thread.canRespond).toBe(true);
    expect(thread.entries).toHaveLength(1);
    expect(thread.entries[0]).toMatchObject({
      kind: 'supplier_response',
      authorUserId: f.vendorAId,
      proposedResolution: 'replace',
      evidenceFileIds: [ownFile],
    });
    const linked = await evidenceRowsFor(delivery.id);
    expect(linked.map((e) => e.fileId)).toEqual([ownFile]);

    // A second reply with the same file never duplicates the evidence row.
    await respondToDiscrepancy(f.vendorA, delivery.id, discrepancy.id, {
      response: 'Adding the depot note as well.',
      proposedResolution: 'replace',
      evidenceFileIds: [ownFile],
    });
    expect(await evidenceRowsFor(delivery.id)).toHaveLength(1);

    const staffView = await listDiscrepancyThreads(f.staff, delivery.id);
    expect(staffView.items[0]).toMatchObject({ responseState: 'responded', canDecide: true });
    expect(staffView.items[0]!.entries).toHaveLength(2);
    const [event] = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'delivery.discrepancy.supplier_responded'),
          eq(schema.outboxEvents.aggregateId, delivery.id),
        ),
      );
    expect(event?.payload).toMatchObject({
      discrepancyId: discrepancy.id,
      purchaseOrderId: po.id,
      recipientUserIds: [f.staffId],
    });
    const audit = await dbs.owner
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'discrepancy'),
          eq(schema.auditEvents.entityId, discrepancy.id),
        ),
      );
    expect(audit.map((a) => a.action)).toContain('delivery.discrepancy_supplier_responded');
  });

  it('staff reject then accept; the closing status follows the proposal and the supplier is told', async () => {
    expect(
      await errorCode(
        decideDiscrepancyResponse(f.vendorA, delivery.id, discrepancy.id, {
          decision: 'accept',
          reason: 'I accept my own proposal',
        }),
      ),
    ).toBe('forbidden');
    const rejected = await decideDiscrepancyResponse(f.staff, delivery.id, discrepancy.id, {
      decision: 'reject',
      reason: 'The site needs the cement this week; a credit is preferable.',
    });
    expect(rejected.responseState).toBe('rejected');
    expect(rejected.discrepancy.status).toBe('supplier_notified');
    expect(rejected.canDecide).toBe(false);
    // Nothing new to decide until the supplier replies again.
    expect(
      await errorCode(
        decideDiscrepancyResponse(f.staff, delivery.id, discrepancy.id, {
          decision: 'accept',
          reason: 'x',
        }),
      ),
    ).toBe('invalid_transition');
    const vendorView = await listDiscrepancyThreads(f.vendorA, delivery.id);
    const decision = vendorView.items[0]!.entries.at(-1)!;
    expect(decision).toMatchObject({ kind: 'staff_decision', decision: 'reject' });
    expect(decision.text).toContain('credit is preferable');
    expect(vendorView.items[0]!.canRespond).toBe(true);

    await respondToDiscrepancy(f.vendorA, delivery.id, discrepancy.id, {
      response: 'Understood; we will credit the ten bags against the order.',
      proposedResolution: 'credit',
      evidenceFileIds: [],
    });
    const accepted = await decideDiscrepancyResponse(f.staff, delivery.id, discrepancy.id, {
      decision: 'accept',
      reason: 'Credit note for 10 bags agreed with the supplier.',
    });
    expect(accepted.responseState).toBe('accepted');
    expect(accepted.discrepancy.status).toBe('credited');
    expect(accepted.discrepancy.resolution).toContain('Credit note');
    expect(accepted.discrepancy.resolvedAt).not.toBeNull();
    expect(accepted.canRespond).toBe(false);
    expect(
      await errorCode(
        respondToDiscrepancy(f.vendorA, delivery.id, discrepancy.id, {
          response: 'One more thing',
          proposedResolution: 'dispute',
          evidenceFileIds: [],
        }),
      ),
    ).toBe('invalid_transition');
    const decided = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.eventType, 'delivery.discrepancy.decided'),
          eq(schema.outboxEvents.aggregateId, delivery.id),
        ),
      );
    expect(decided.map((e) => (e.payload as { decision: string }).decision)).toEqual([
      'reject',
      'accept',
    ]);
    expect(decided[1]?.payload).toMatchObject({ outcome: 'credited', recipientUserIds: [f.vendorAId] });
    // With every discrepancy closed the delivery can be accepted.
    expect((await acceptDelivery(f.staff, delivery.id)).status).toBe('accepted');
  });

  it('the vendor can open a conversation about the order with the staff who issued it; competitors cannot', async () => {
    const conversation = await startPartnerConversation(f.vendorA, {
      entityType: 'purchase_order',
      entityId: po.id,
      subject: `Replacement delivery for ${po.number}`,
      message: 'When can the site receive the ten replacement bags?',
    });
    expect(conversation.kind).toBe('partner');
    expect(conversation.staffParticipantUserIds).toEqual([f.staffId]);
    const participantIds = conversation.participants.map((p) => p.userId).sort();
    expect(participantIds).toEqual([f.staffId, f.vendorAId].sort());
    expect(participantIds).not.toContain(f.customerId);
    expect(
      await errorCode(
        startPartnerConversation(f.vendorB, {
          entityType: 'purchase_order',
          entityId: po.id,
          subject: 'About that order',
          message: 'Can I see it?',
        }),
      ),
    ).toMatch(/not_found|forbidden/);
    expect(
      await errorCode(
        startPartnerConversation(f.customer, {
          entityType: 'purchase_order',
          entityId: po.id,
          subject: 'Customer thread',
          message: 'Hello',
        }),
      ),
    ).toBe('forbidden');
  });
});
