import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketDetailSchema } from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { inviteTenderPartners, createTender, publishTender } from '@/server/tenders/tenders';
import {
  customerIdentity,
  enableCommercialFlags,
  enabledFlags,
  hoursFromNow,
  insertOrganization,
  insertPartner,
  insertStaff,
  partnerIdentity,
  staffIdentity,
} from '@/server/tenders/test-fixtures';
import { getMarketBySlug } from './queries';
import { anonymousIdentity, seedAndPublish } from './test-fixtures';
import { tenderScopeFor } from './tenders';

/**
 * Location panel tender opportunities (brief §6.2): open, published tenders
 * reach the market through project → market, project → property → market or
 * service request → market, and only the people the tendering visibility
 * rules already allow see them. Anonymous visitors get an honest empty
 * result, never a leaked existence.
 */

let dbs: TestDatabases;
const admin = staffIdentity('mkt-tnd-admin', ['super_admin']);
const invited = partnerIdentity('mkt-tnd-partner-a');
const uninvited = partnerIdentity('mkt-tnd-partner-b');
const customer = customerIdentity('mkt-tnd-customer', 'mkt-tnd-org');
const stranger = customerIdentity('mkt-tnd-stranger', 'mkt-tnd-org-b');
const anon = anonymousIdentity('tok-mkt-tnd', enabledFlags);
const anonModuleOff = anonymousIdentity('tok-mkt-tnd', {});
let lagosId: string;
let ikejaId: string;

async function marketId(slug: string): Promise<string> {
  const [row] = await dbs.owner
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(eq(schema.markets.slug, slug));
  if (!row) throw new Error(`market ${slug} missing`);
  return row.id;
}

function tenderInput(projectId: string, title: string) {
  return {
    organizationId: 'mkt-tnd-org',
    projectId,
    title,
    scopeFileIds: [],
    timeline: {
      releaseAt: hoursFromNow(-1),
      questionCutoffAt: hoursFromNow(1),
      submissionDeadlineAt: hoursFromNow(48),
      evaluationCompleteAt: hoursFromNow(72),
      awardTargetAt: hoursFromNow(96),
    },
    displayTimeZone: 'Africa/Lagos',
    evaluationWeights: { price: 60, quality: 40 },
    partnerDisclosure: 'No interest held.',
    sealed: true,
  } as Parameters<typeof createTender>[1];
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedAndPublish(dbs.owner);
  await enableCommercialFlags(dbs.owner);
  await insertStaff(dbs.owner, 'mkt-tnd-admin', ['super_admin']);
  await insertPartner(dbs.owner, 'mkt-tnd-partner-a');
  await insertPartner(dbs.owner, 'mkt-tnd-partner-b');
  await insertOrganization(dbs.owner, 'mkt-tnd-org', [
    { userId: 'mkt-tnd-customer', role: 'owner' },
  ]);
  await insertOrganization(dbs.owner, 'mkt-tnd-org-b', [
    { userId: 'mkt-tnd-stranger', role: 'owner' },
  ]);
  lagosId = await marketId('ng-lagos');
  ikejaId = await marketId('ng-ikeja');
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('tender opportunities on the market detail', () => {
  it('links open tenders through the project or its property and scopes them to who may see them', async () => {
    // Project A sits in Lagos directly; project B reaches Ikeja through its property.
    const [projectA] = await dbs.owner
      .insert(schema.projects)
      .values({
        organizationId: 'mkt-tnd-org',
        marketId: lagosId,
        name: 'Lekki duplex',
        kind: 'construction_monitoring',
      })
      .returning({ id: schema.projects.id });
    const [property] = await dbs.owner
      .insert(schema.properties)
      .values({
        organizationId: 'mkt-tnd-org',
        name: 'Ikeja GRA plot',
        kind: 'land',
        marketId: ikejaId,
      })
      .returning({ id: schema.properties.id });
    const [projectB] = await dbs.owner
      .insert(schema.projects)
      .values({
        organizationId: 'mkt-tnd-org',
        propertyId: property!.id,
        name: 'Ikeja GRA terrace',
        kind: 'architecture',
      })
      .returning({ id: schema.projects.id });

    const lagosTender = await createTender(admin, tenderInput(projectA!.id, 'Lekki duplex works'));
    const ikejaTender = await createTender(admin, tenderInput(projectB!.id, 'Ikeja GRA terrace'));
    const draftOnly = await createTender(admin, tenderInput(projectA!.id, 'Not published yet'));
    await inviteTenderPartners(admin, lagosTender.id, { partnerUserIds: ['mkt-tnd-partner-a'] });
    await publishTender(admin, lagosTender.id, { expectedVersion: lagosTender.version });
    await publishTender(admin, ikejaTender.id, { expectedVersion: ikejaTender.version });
    expect(draftOnly.status).toBe('draft');

    // Anonymous: no query, no leak, honest scope.
    const publicLagos = await getMarketBySlug('ng-lagos', anon);
    expect(marketDetailSchema.safeParse(publicLagos).success).toBe(true);
    expect(publicLagos?.tenderOpportunities).toEqual({
      moduleEnabled: true,
      scope: 'none',
      items: [],
    });
    expect(tenderScopeFor(anon)).toBe('none');
    expect((await getMarketBySlug('ng-lagos', anonModuleOff))?.tenderOpportunities).toEqual({
      moduleEnabled: false,
      scope: 'none',
      items: [],
    });

    // Staff see the open tender with its admin link; drafts never appear.
    const staffLagos = await getMarketBySlug('ng-lagos', admin);
    expect(staffLagos?.tenderOpportunities.scope).toBe('staff');
    expect(staffLagos?.tenderOpportunities.items).toHaveLength(1);
    expect(staffLagos?.tenderOpportunities.items[0]).toMatchObject({
      id: lagosTender.id,
      reference: lagosTender.reference,
      title: 'Lekki duplex works',
      status: 'published',
      linkedThrough: 'project',
      href: `/admin/tenders/${lagosTender.id}`,
    });
    const [storedTender] = await dbs.owner
      .select({ deadline: schema.tenders.submissionDeadlineAt })
      .from(schema.tenders)
      .where(eq(schema.tenders.id, lagosTender.id));
    expect(staffLagos?.tenderOpportunities.items[0]?.submissionDeadlineAt).toBe(
      storedTender!.deadline!.toISOString(),
    );
    expect(staffLagos?.tenderOpportunities.items[0]?.displayTimeZone).toBe('Africa/Lagos');

    // Property link: the Ikeja tender reaches Ikeja, not Lagos.
    const staffIkeja = await getMarketBySlug('ng-ikeja', admin);
    expect(staffIkeja?.tenderOpportunities.items.map((t) => t.id)).toEqual([ikejaTender.id]);
    expect(staffIkeja?.tenderOpportunities.items[0]?.linkedThrough).toBe('property');

    // Invited partner sees the invitation with the partner link; an uninvited partner nothing.
    const partnerLagos = await getMarketBySlug('ng-lagos', invited);
    expect(partnerLagos?.tenderOpportunities.scope).toBe('partner');
    expect(partnerLagos?.tenderOpportunities.items.map((t) => t.href)).toEqual([
      `/partner/tenders/${lagosTender.id}`,
    ]);
    const otherPartner = await getMarketBySlug('ng-lagos', uninvited);
    expect(otherPartner?.tenderOpportunities).toEqual({
      moduleEnabled: true,
      scope: 'partner',
      items: [],
    });

    // Customers see their own organisation's tender (no workspace page yet), strangers nothing.
    const customerLagos = await getMarketBySlug('ng-lagos', customer);
    expect(customerLagos?.tenderOpportunities.scope).toBe('customer');
    expect(customerLagos?.tenderOpportunities.items.map((t) => t.id)).toEqual([lagosTender.id]);
    expect(customerLagos?.tenderOpportunities.items[0]?.href).toBeNull();
    const strangerLagos = await getMarketBySlug('ng-lagos', stranger);
    expect(strangerLagos?.tenderOpportunities.items).toEqual([]);

    // Closing the window hides the tender everywhere; the module flag hides the section.
    await dbs.owner
      .update(schema.tenders)
      .set({ submissionDeadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.tenders.id, lagosTender.id));
    expect((await getMarketBySlug('ng-lagos', admin))?.tenderOpportunities.items).toEqual([]);
    const flagOff = staffIdentity('mkt-tnd-admin', ['super_admin'], { flags: {} });
    expect((await getMarketBySlug('ng-lagos', flagOff))?.tenderOpportunities).toEqual({
      moduleEnabled: false,
      scope: 'none',
      items: [],
    });
  });
});
