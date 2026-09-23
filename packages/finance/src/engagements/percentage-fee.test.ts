import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { getInvoice } from '../invoices';
import type { FinanceRuntime } from '../runtime';
import {
  customerActor,
  devProviderRuntime,
  insertServiceRequest,
  seedTenants,
  staffActor,
  type Tenants,
} from '../testing/fixtures';
import { acceptQuote, addQuoteVersion, createQuote, issueQuote } from './quotes';
import { triageServiceRequest } from './triage';

/**
 * Build brief §2: never calculate a purchase-support invoice without an
 * agreed percentage basis and signed scope. A percentage-basis quote is
 * refused at issue and at acceptance unless the percentage, the agreed basis
 * amount and the customer-signed scope file are recorded, and the invoice
 * raised on acceptance is computed from the agreed basis only.
 */

let dbs: TestDatabases;
let t: Tenants;
let rt: FinanceRuntime;
let purchaseServiceId = '';
const fileIds: string[] = [];
const requestIds: string[] = [];

async function purchaseRequest(): Promise<string> {
  const sr = await insertServiceRequest(dbs.owner, t, {
    organizationId: t.orgA,
    requestedByUserId: t.userA,
  });
  await dbs.owner
    .update(schema.serviceRequests)
    .set({ serviceId: purchaseServiceId, title: 'Represent me on Plot 5' })
    .where(eq(schema.serviceRequests.id, sr.id));
  await triageServiceRequest(
    rt,
    staffActor({ userId: t.opsUser, roles: ['operations_manager'] }),
    sr.id,
    {
      assignedPmUserId: t.opsUser,
      priority: 3,
      expectedVersion: 1,
    },
  );
  requestIds.push(sr.id);
  return sr.id;
}

async function signedScope(
  serviceRequestId: string,
  status: 'clean' | 'scanning' = 'clean',
): Promise<string> {
  const content = randomUUID();
  const [row] = await dbs.owner
    .insert(schema.fileObjects)
    .values({
      organizationId: t.orgA,
      ownerUserId: t.userA,
      bucket: 'private',
      storageKey: `test/fee-basis/${uniqueSuffix()}-${content}`,
      originalName: 'signed-scope.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 100,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
      status,
      purpose: 'org_document',
      entityType: 'service_request',
      entityId: serviceRequestId,
    })
    .returning({ id: schema.fileObjects.id });
  fileIds.push(row!.id);
  return row!.id;
}

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e as { code?: string }).code,
  );

beforeAll(async () => {
  dbs = connectTestDatabases();
  t = await seedTenants(dbs.owner);
  ({ rt } = devProviderRuntime(dbs.app));
  const [service] = await dbs.owner
    .insert(schema.services)
    .values({
      slug: `purchase-support-${t.sfx}`,
      name: 'Purchase representation (finance test)',
      shortDescription: 'test',
      workflowTemplateKey: 'purchase_support',
      publicationState: 'published',
    })
    .returning({ id: schema.services.id });
  purchaseServiceId = service!.id;
  await dbs.owner.insert(schema.servicePackages).values({
    serviceId: purchaseServiceId,
    slug: 'percentage',
    name: 'Purchase representation',
    priceBasis: 'percentage',
    percentageBps: 150,
    publicationState: 'published',
  });
  await dbs.owner.insert(schema.slaPolicies).values({
    serviceId: purchaseServiceId,
    stage: 'triage',
    targetHours: 24,
    businessHoursOnly: false,
  });
});

afterAll(async () => {
  const o = dbs.owner;
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // best effort
    }
  };
  if (fileIds.length > 0)
    await attempt(() => o.delete(schema.fileObjects).where(eq(schema.fileObjects.id, fileIds[0]!)));
  await attempt(() =>
    o.delete(schema.servicePackages).where(eq(schema.servicePackages.serviceId, purchaseServiceId)),
  );
  await attempt(() =>
    o.delete(schema.slaPolicies).where(eq(schema.slaPolicies.serviceId, purchaseServiceId)),
  );
  await dbs.close();
});

describe('percentage-basis purchase-support fees', () => {
  it('refuses a percentage fee without the agreed basis amount', async () => {
    const srId = await purchaseRequest();
    const ops = staffActor({ userId: t.opsUser, roles: ['operations_manager'] });
    expect(
      await code(
        createQuote(rt, ops, srId, {
          feeBasis: { percentageBps: 150 },
          lines: [{ description: 'Fee', quantity: '1', unitAmountKobo: '100000' }],
          currency: 'NGN',
          depositBps: 10_000,
          requiresPayment: true,
          scopeMarkdown: 'Represent the buyer on Plot 5.',
        }),
      ),
    ).toBe('validation_failed');
  });

  it('refuses to issue typed lines on a percentage-priced service, and a percentage quote without the signed scope', async () => {
    const srId = await purchaseRequest();
    const ops = staffActor({ userId: t.opsUser, roles: ['operations_manager'] });
    const typed = await createQuote(rt, ops, srId, {
      lines: [{ description: 'Flat fee', quantity: '1', unitAmountKobo: '50000000' }],
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
      scopeMarkdown: 'Represent the buyer on Plot 5.',
    });
    await expect(issueQuote(rt, ops, typed.id, { validDays: 7 })).rejects.toMatchObject({
      code: 'insufficient_evidence',
    });
    const unsigned = await addQuoteVersion(rt, ops, typed.id, {
      lines: [{ description: 'ignored', quantity: '1', unitAmountKobo: '1' }],
      feeBasis: {
        percentageBps: 150,
        basisAmountKobo: '4600000000',
        basisKind: 'agreed_purchase_price',
      },
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
      scopeMarkdown: 'Represent the buyer on Plot 5.',
    });
    // The line is derived from the basis, never typed.
    expect(unsigned.versions[1]!.lines).toHaveLength(1);
    expect(unsigned.versions[1]!.subtotalKobo).toBe('69000000');
    const err = await issueQuote(rt, ops, typed.id, { validDays: 7 }).then(
      () => null,
      (e: unknown) => e as { code: string; details: Array<{ path: string }> },
    );
    expect(err?.code).toBe('insufficient_evidence');
    expect(err?.details.map((d) => d.path)).toEqual(['feeBasis.signedScopeFileId']);
    // A scope file still being scanned is not enough either.
    const scanning = await signedScope(srId, 'scanning');
    const withScanning = await addQuoteVersion(rt, ops, typed.id, {
      lines: [{ description: 'ignored', quantity: '1', unitAmountKobo: '1' }],
      feeBasis: { percentageBps: 150, basisAmountKobo: '4600000000', signedScopeFileId: scanning },
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
      scopeMarkdown: 'Represent the buyer on Plot 5.',
    });
    expect(withScanning.currentVersion).toBe(3);
    await expect(issueQuote(rt, ops, typed.id, { validDays: 7 })).rejects.toMatchObject({
      code: 'insufficient_evidence',
    });
  });

  it('issues and accepts with an agreed basis and signed scope, invoicing from the basis only', async () => {
    const srId = await purchaseRequest();
    const ops = staffActor({ userId: t.opsUser, roles: ['operations_manager'] });
    const customer = customerActor({ userId: t.userA, organizationId: t.orgA });
    const scope = await signedScope(srId);
    const quote = await createQuote(rt, ops, srId, {
      feeBasis: {
        percentageBps: 150,
        basisAmountKobo: '4600000000',
        basisKind: 'agreed_purchase_price',
        basisDescription: 'the agreed purchase price of Plot 5 (₦46,000,000)',
        signedScopeFileId: scope,
      },
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
      scopeMarkdown: 'Represent the buyer on Plot 5 through offer, conditions and closing.',
    });
    expect(quote.versions[0]!.lines).toEqual([
      expect.objectContaining({
        description: '1.50% of the agreed purchase price of Plot 5 (₦46,000,000)',
        unitAmountKobo: '69000000',
        amountKobo: '69000000',
      }),
    ]);
    const issued = await issueQuote(rt, ops, quote.id, { validDays: 7 });
    expect(issued.status).toBe('issued');
    const accepted = await acceptQuote(rt, customer, quote.id, {
      quoteVersionId: issued.versions[0]!.id,
      signatureName: 'Ada A',
      termsVersion: '2026-09',
      acceptTerms: true,
    });
    expect(accepted.quote.status).toBe('accepted');
    expect(accepted.invoiceId).not.toBeNull();
    const invoice = await getInvoice(rt, customer, accepted.invoiceId!);
    // The invoice carries exactly the fee derived from the agreed basis (subtotal before tax).
    expect(invoice.subtotalKobo).toBe('69000000');
    const [sr] = await dbs.owner
      .select({ feeBasis: schema.serviceRequests.feeBasis })
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, srId));
    expect(sr!.feeBasis).toMatchObject({
      percentageBps: 150,
      basisAmountKobo: '4600000000',
      signedScopeFileId: scope,
    });
    expect((sr!.feeBasis as { agreedAt?: string }).agreedAt).toBeTruthy();
  });
});
