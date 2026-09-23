import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import {
  createFixture,
  customerIdentity,
  errorCode,
  identityFor,
  insertFile,
  opsIdentity,
  supportIdentity,
  type Fixture,
} from '@/server/assignments/testing/fixtures';
import {
  rejectOwnerAuthority,
  submitOwnerAuthority,
  verifyOwnerAuthority,
} from './owner-authorities';
import { createParcel, listParcels } from './parcels';
import { archiveProperty, createProperty, getProperty, getPropertyOverview, listProperties, updateProperty } from './service';
import { createUnit, listUnits } from './units';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture();
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

describe('properties', () => {
  it('creates, reads, updates and archives a property for the customer organisation', async () => {
    const owner = customerIdentity(f, 'A');
    const created = await createProperty(owner, {
      name: 'Lekki plot',
      kind: 'land',
      address: { city: 'Lagos', state: 'Lagos', country: 'NG' },
      location: { lon: 3.47, lat: 6.43 },
      preciseLocationPublic: false,
      landArea: { value: '1.5', unit: 'acre' },
      titleStatus: 'unknown',
    });
    expect(created.organizationId).toBe(f.orgA);
    expect(created.location).toEqual({ lon: 3.47, lat: 6.43 });
    expect(created.landArea).toEqual({ declaredValue: '1.5', declaredUnit: 'acre', m2: '6070.28' });
    expect(created.preciseLocationPublic).toBe(false);
    expect(created.version).toBe(1);

    const read = await getProperty(owner, created.id);
    expect(read.landArea?.declaredValue).toBe('1.5');

    const updated = await updateProperty(owner, created.id, {
      expectedVersion: 1,
      titleStatus: 'documents_received',
      landArea: { value: '2', unit: 'plot' },
    });
    expect(updated.version).toBe(2);
    expect(updated.titleStatus).toBe('documents_received');
    // A plot has no fixed size: the declared value is kept and no m² is invented.
    expect(updated.landArea).toEqual({ declaredValue: '2', declaredUnit: 'plot', m2: null });

    await expect(
      updateProperty(owner, created.id, { expectedVersion: 1, name: 'stale' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');

    const archived = await archiveProperty(owner, created.id, { expectedVersion: 2, reason: 'sold' });
    expect(archived.status).toBe('archived');
    const audits = await f.dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, created.id));
    expect(audits.map((a) => a.action).sort()).toEqual(['property.archived', 'property.created', 'property.updated']);
  });

  it('lists with filters and text search inside the active organisation only', async () => {
    const ownerA = customerIdentity(f, 'A');
    await createProperty(ownerA, { name: 'Ikeja duplex', kind: 'residential', address: { city: 'Ikeja' }, preciseLocationPublic: false, titleStatus: 'unknown' });
    await createProperty(customerIdentity(f, 'B'), { name: 'Abuja warehouse', kind: 'industrial', preciseLocationPublic: false, titleStatus: 'unknown' });
    const all = await listProperties(ownerA, { limit: 25, status: 'active' });
    expect(all.items.every((p) => p.organizationId === f.orgA)).toBe(true);
    expect(all.items.some((p) => p.name === 'Abuja warehouse')).toBe(false);
    const byCity = await listProperties(ownerA, { limit: 25, status: 'active', q: 'ikeja' });
    expect(byCity.items.map((p) => p.name)).toEqual(['Ikeja duplex']);
    const byKind = await listProperties(ownerA, { limit: 25, status: 'active', kind: 'industrial' });
    expect(byKind.items).toHaveLength(0);
    const staffAll = await listProperties(opsIdentity(f), { limit: 25, status: 'active' });
    expect(staffAll.items.some((p) => p.name === 'Abuja warehouse')).toBe(true);
  });

  it('denies cross-organisation access at the SQL level and at the policy level', async () => {
    const ownerA = customerIdentity(f, 'A');
    const created = await createProperty(ownerA, { name: 'Private A', kind: 'land', preciseLocationPublic: false, titleStatus: 'unknown' });
    // SQL level: org B's row-level context cannot see the row, so the service reports not_found.
    await expect(getProperty(customerIdentity(f, 'B'), created.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(
      updateProperty(customerIdentity(f, 'B'), created.id, { expectedVersion: 1, name: 'hijack' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // Policy level: a misconfigured identity whose SQL context is org A but whose memberships are org B is still refused.
    const confused = identityFor(f.ownerB, {
      memberships: [{ organizationId: f.orgB, role: 'owner' }],
      activeOrganizationId: f.orgA,
    });
    await expect(getProperty(confused, created.id)).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // Policy level for staff: support can see rows but lacks customers.manage.
    await expect(
      updateProperty(supportIdentity(f), created.id, { expectedVersion: 1, name: 'support edit' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // An adviser reads but cannot manage.
    await expect(
      updateProperty(customerIdentity(f, 'A', 'adviser'), created.id, { expectedVersion: 1, name: 'adviser edit' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    expect((await getProperty(customerIdentity(f, 'A', 'adviser'), created.id)).name).toBe('Private A');
  });

  it('manages parcels and units and builds the overview', async () => {
    const ownerA = customerIdentity(f, 'A');
    const property = await createProperty(ownerA, { name: 'Estate block', kind: 'residential', preciseLocationPublic: false, titleStatus: 'unknown' });
    const parcel = await createParcel(ownerA, property.id, {
      reference: 'P1',
      area: { value: '600', unit: 'm2' },
      boundary: [
        [
          [3.4, 6.4],
          [3.41, 6.4],
          [3.41, 6.41],
          [3.4, 6.41],
          [3.4, 6.4],
        ],
      ],
      titleDisclosures: { governorsConsent: 'pending' },
    });
    expect(parcel.boundary?.type).toBe('Polygon');
    expect(parcel.boundary?.coordinates[0]).toHaveLength(5);
    expect(parcel.area).toEqual({ declaredValue: '600', declaredUnit: 'm2', m2: '600.00' });
    expect((await listParcels(ownerA, property.id)).map((p) => p.reference)).toEqual(['P1']);
    await createUnit(ownerA, property.id, { label: 'A1', unitType: 'flat', status: 'occupied' });
    await createUnit(ownerA, property.id, { label: 'A2', unitType: 'flat', status: 'vacant' });
    await expect(createUnit(ownerA, property.id, { label: 'A1', unitType: 'flat', status: 'vacant' })).rejects.toSatisfy((e) => errorCode(e) === 'conflict');
    expect((await listUnits(ownerA, property.id)).map((u) => u.label)).toEqual(['A1', 'A2']);
    await f.dbs.owner.insert(schema.projects).values({ organizationId: f.orgA, propertyId: property.id, name: 'Renovation', kind: 'renovation' });
    const overview = await getPropertyOverview(ownerA, property.id);
    expect(overview.units).toEqual({ total: 2, occupied: 1, vacant: 1, unavailable: 0, occupancyPercent: 50 });
    expect(overview.parcelsCount).toBe(1);
    expect(overview.linkedProjectsCount).toBe(1);
    expect(overview.ownerAuthority).toBeNull();
    await expect(getPropertyOverview(customerIdentity(f, 'B'), property.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
  });

  it('lets the customer submit an owner authority that only staff with rentals.manage can verify', async () => {
    const ownerA = customerIdentity(f, 'A');
    const property = await createProperty(ownerA, { name: 'Listing candidate', kind: 'land', preciseLocationPublic: false, titleStatus: 'unknown' });
    const foreignFile = await insertFile(f.dbs.owner, f.orgB, f.ownerB);
    await expect(
      submitOwnerAuthority(ownerA, property.id, { ownerName: 'Chief A', authorityDocumentFileId: foreignFile }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const infected = await insertFile(f.dbs.owner, f.orgA, f.ownerA, 'infected');
    await expect(
      submitOwnerAuthority(ownerA, property.id, { ownerName: 'Chief A', authorityDocumentFileId: infected }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_quarantined');
    const file = await insertFile(f.dbs.owner, f.orgA, f.ownerA);
    const authority = await submitOwnerAuthority(ownerA, property.id, { ownerName: 'Chief A', authorityDocumentFileId: file });
    expect(authority.status).toBe('pending');
    // The customer cannot verify their own authority; support lacks rentals.manage.
    await expect(verifyOwnerAuthority(ownerA, property.id, authority.id, {})).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(verifyOwnerAuthority(supportIdentity(f), property.id, authority.id, {})).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const verified = await verifyOwnerAuthority(opsIdentity(f), property.id, authority.id, { expiresAt });
    expect(verified.status).toBe('verified');
    expect(verified.effectiveStatus).toBe('verified');
    expect(verified.verifiedBy).toBe(f.ops);
    await expect(rejectOwnerAuthority(opsIdentity(f), property.id, authority.id, { reason: 'late' })).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    // Expiry is derived from the date.
    await f.dbs.owner
      .update(schema.ownerAuthorities)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.ownerAuthorities.id, authority.id));
    const overview = await getPropertyOverview(ownerA, property.id);
    expect(overview.ownerAuthority?.effectiveStatus).toBe('expired');
  });
});
