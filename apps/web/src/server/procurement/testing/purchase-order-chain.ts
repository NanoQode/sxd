import { schema, type Database } from '@simplexd/db';
import { chartOfAccounts } from '@simplexd/db/seed';
import { uniqueSuffix } from '@simplexd/db/testing';
import type { PurchaseOrderDetail } from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  customerIdentity,
  enableCommercialFlags,
  hoursFromNow,
  insertOrganization,
  insertPartner,
  insertStaff,
  partnerIdentity,
  staffIdentity,
} from '@/server/tenders/test-fixtures';
import { createPurchaseOrder, issuePurchaseOrder } from '../purchase-orders';
import { createRfq, issueRfq, submitRfqResponse } from '../rfqs';

/**
 * Fixture for the partner-workspace procurement tests: unique-suffixed staff,
 * two vendors, a customer organisation and a stranger organisation, the
 * commercial feature flags and the seeded chart of accounts. Nothing is
 * truncated, so the file can run next to other integration tests.
 */

export interface ChainFixture {
  sfx: string;
  staffId: string;
  financeAId: string;
  financeBId: string;
  vendorAId: string;
  vendorBId: string;
  customerId: string;
  strangerId: string;
  orgId: string;
  strangerOrgId: string;
  staff: RequestIdentity;
  financeA: RequestIdentity;
  financeB: RequestIdentity;
  vendorA: RequestIdentity;
  vendorB: RequestIdentity;
  customer: RequestIdentity;
  stranger: RequestIdentity;
}

export async function seedChainFixture(owner: Database): Promise<ChainFixture> {
  const sfx = uniqueSuffix();
  const ids = {
    staffId: `pchain-staff-${sfx}`,
    financeAId: `pchain-fin-a-${sfx}`,
    financeBId: `pchain-fin-b-${sfx}`,
    vendorAId: `pchain-vendor-a-${sfx}`,
    vendorBId: `pchain-vendor-b-${sfx}`,
    customerId: `pchain-customer-${sfx}`,
    strangerId: `pchain-stranger-${sfx}`,
    orgId: `pchain-org-${sfx}`,
    strangerOrgId: `pchain-org-x-${sfx}`,
  };
  await enableCommercialFlags(owner);
  await owner
    .insert(schema.ledgerAccounts)
    .values(chartOfAccounts)
    .onConflictDoNothing({ target: schema.ledgerAccounts.code });
  await insertStaff(owner, ids.staffId, ['operations_manager']);
  await insertStaff(owner, ids.financeAId, ['finance']);
  await insertStaff(owner, ids.financeBId, ['finance']);
  await insertPartner(owner, ids.vendorAId, 'vendor');
  await insertPartner(owner, ids.vendorBId, 'vendor');
  await insertOrganization(owner, ids.orgId, [{ userId: ids.customerId, role: 'owner' }]);
  await insertOrganization(owner, ids.strangerOrgId, [{ userId: ids.strangerId, role: 'owner' }]);
  return {
    sfx,
    ...ids,
    staff: staffIdentity(ids.staffId, ['operations_manager']),
    financeA: staffIdentity(ids.financeAId, ['finance'], { mfaVerified: true }),
    financeB: staffIdentity(ids.financeBId, ['finance'], { mfaVerified: true }),
    vendorA: partnerIdentity(ids.vendorAId),
    vendorB: partnerIdentity(ids.vendorBId),
    customer: customerIdentity(ids.customerId, ids.orgId),
    stranger: customerIdentity(ids.strangerId, ids.strangerOrgId),
  };
}

/** RFQ for 100 bags of cement, priced by the vendor at ₦12,000 a bag, ordered and issued: total 120,000,000 kobo. */
export async function issuedPurchaseOrderFor(
  f: ChainFixture,
  vendor: RequestIdentity,
  title = 'Cement for the Lekki site',
): Promise<PurchaseOrderDetail> {
  const rfq = await createRfq(f.staff, {
    organizationId: f.orgId,
    title,
    items: [{ material: 'cement', specification: '42.5R, 50kg', unit: 'bag', quantity: '100' }],
  });
  const vendorId = vendor.session!.user.id;
  await issueRfq(f.staff, rfq.id, { deadlineAt: hoursFromNow(24), supplierUserIds: [vendorId] });
  const response = await submitRfqResponse(vendor, rfq.id, {
    currency: 'NGN',
    lines: [{ itemId: rfq.items[0]!.id, unitPriceKobo: '1200000', quantityUnit: 'bag' }],
    deliveryKobo: '0',
    submit: true,
  });
  const po = await createPurchaseOrder(f.staff, { responseId: response.id, lineConversions: [] });
  return issuePurchaseOrder(f.staff, po.id, { expectedVersion: po.version });
}

/** A file object owned by a partner user (not attached to any organisation), as the upload pipeline leaves it. */
export async function insertPartnerFile(
  owner: Database,
  ownerUserId: string,
  status: 'clean' | 'scanning' | 'infected' = 'clean',
): Promise<string> {
  const key = `partner/${ownerUserId}/${uniqueSuffix()}`;
  const [row] = await owner
    .insert(schema.fileObjects)
    .values({
      organizationId: null,
      ownerUserId,
      bucket: status === 'clean' ? 'private' : 'quarantine',
      storageKey: key,
      originalName: 'invoice.pdf',
      declaredMime: 'application/pdf',
      detectedMime: 'application/pdf',
      sizeBytes: 4321,
      checksumSha256: status === 'scanning' ? null : `sha-${key}`,
      status,
      purpose: 'partner_submission',
    })
    .returning({ id: schema.fileObjects.id });
  return row!.id;
}
