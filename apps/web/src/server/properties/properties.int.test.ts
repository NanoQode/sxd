import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import {
  createFixture,
  customerIdentity,
  errorCode,
  identityFor,
  insertFile,
  insertProperty,
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
import {
  archiveProperty,
  createProperty,
  getProperty,
  getPropertyOverview,
  listProperties,
  updateProperty,
} from './service';
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
  it('creates a property for the customer organisation', async () => {
    const created = await createProperty(customerIdentity(f, 'A'), {
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
    expect(created.version).toBe(1);
  });

  it('refuses to create a property outside the active organisation', async () => {
    await expect(
      createProperty(customerIdentity(f, 'A'), {
        name: 'Elsewhere',
        kind: 'land',
        organizationId: f.orgB,
        preciseLocationPublic: false,
        titleStatus: 'unknown',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createProperty(customerIdentity(f, 'A', 'adviser'), {
        name: 'Adviser',
        kind: 'land',
        preciseLocationPublic: false,
        titleStatus: 'unknown',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createProperty(supportIdentity(f), {
        name: 'Support',
        kind: 'land',
        organizationId: f.orgA,
        preciseLocationPublic: false,
        titleStatus: 'unknown',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
  });

  it('reads, updates (with optimistic concurrency) and archives a property', async () => {
    const owner = customerIdentity(f, 'A');
    const id = await insertProperty(f.dbs.owner, f.orgA, {
      name: 'Lekki plot',
      location: { lon: 3.47, lat: 6.43 },
      landAreaDeclaredValue: '1.500',
      landAreaDeclaredUnit: 'acre',
      landAreaM2: '6070.28',
    });
    const read = await getProperty(owner, id);
    expect(read.location).toEqual({ lon: 3.47, lat: 6.43 });
    expect(read.landArea).toEqual({ declaredValue: '1.5', declaredUnit: 'acre', m2: '6070.28' });
    expect(read.preciseLocationPublic).toBe(false);

    const updated = await updateProperty(owner, id, {
      expectedVersion: 1,
      titleStatus: 'documents_received',
      landArea: { value: '2', unit: 'plot' },
      floorAreaM2: '120.5',
    });
    expect(updated.version).toBe(2);
    expect(updated.titleStatus).toBe('documents_received');
    // A plot has no fixed size: the declared value is kept and no m² is invented.
    expect(updated.landArea).toEqual({ declaredValue: '2', declaredUnit: 'plot', m2: null });
    expect(updated.floorAreaM2).toBe('120.50');

    await expect(
      updateProperty(owner, id, { expectedVersion: 1, name: 'stale' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'version_conflict');
    await expect(
      updateProperty(owner, id, { expectedVersion: 2, landArea: { value: '1.23456', unit: 'm2' } }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');

    const archived = await archiveProperty(owner, id, { expectedVersion: 2, reason: 'sold' });
    expect(archived.status).toBe('archived');
    await expect(updateProperty(owner, id, { expectedVersion: 3, name: 'x' })).rejects.toSatisfy(
      (e) => errorCode(e) === 'invalid_transition',
    );
    const audits = await f.dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual(['property.archived', 'property.updated']);
    expect(audits.find((a) => a.action === 'property.archived')?.reason).toBe('sold');
  });

  it('lists with filters and text search inside the active organisation only', async () => {
    const ownerA = customerIdentity(f, 'A');
    await insertProperty(f.dbs.owner, f.orgA, {
      name: 'Ikeja duplex',
      kind: 'residential',
      address: { city: 'Ikeja' },
    });
    await insertProperty(f.dbs.owner, f.orgA, {
      name: 'Yaba office',
      kind: 'commercial',
      address: { city: 'Yaba' },
    });
    await insertProperty(f.dbs.owner, f.orgB, { name: 'Abuja warehouse', kind: 'industrial' });
    const all = await listProperties(ownerA, { limit: 25, status: 'active' });
    expect(all.items.every((p) => p.organizationId === f.orgA)).toBe(true);
    expect(all.items.some((p) => p.name === 'Abuja warehouse')).toBe(false);
    const byCity = await listProperties(ownerA, { limit: 25, status: 'active', q: 'ikeja' });
    expect(byCity.items.map((p) => p.name)).toEqual(['Ikeja duplex']);
    const byKind = await listProperties(ownerA, {
      limit: 25,
      status: 'active',
      kind: 'industrial',
    });
    expect(byKind.items).toHaveLength(0);
    const page1 = await listProperties(ownerA, { limit: 1, status: 'active' });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listProperties(ownerA, {
      limit: 1,
      status: 'active',
      cursor: page1.nextCursor!,
    });
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    const staffAll = await listProperties(opsIdentity(f), { limit: 25, status: 'active' });
    expect(staffAll.items.some((p) => p.name === 'Abuja warehouse')).toBe(true);
    const staffScoped = await listProperties(opsIdentity(f), {
      limit: 25,
      status: 'active',
      organizationId: f.orgB,
    });
    expect(staffScoped.items.every((p) => p.organizationId === f.orgB)).toBe(true);
  });

  it('denies cross-organisation access at the SQL level and at the policy level', async () => {
    const id = await insertProperty(f.dbs.owner, f.orgA, { name: 'Private A' });
    // SQL level: org B's row-level context cannot see the row, so the service reports not_found.
    await expect(getProperty(customerIdentity(f, 'B'), id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(
      updateProperty(customerIdentity(f, 'B'), id, { expectedVersion: 1, name: 'hijack' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // Policy level: an identity whose SQL context is org A but whose memberships are org B is still refused.
    const confused = identityFor(f.ownerB, {
      memberships: [{ organizationId: f.orgB, role: 'owner' }],
      activeOrganizationId: f.orgA,
    });
    await expect(getProperty(confused, id)).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // Policy level for staff: support can see rows but lacks customers.manage.
    await expect(
      updateProperty(supportIdentity(f), id, { expectedVersion: 1, name: 'support edit' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    // An adviser reads but cannot manage.
    await expect(
      updateProperty(customerIdentity(f, 'A', 'adviser'), id, {
        expectedVersion: 1,
        name: 'adviser edit',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    expect((await getProperty(customerIdentity(f, 'A', 'adviser'), id)).name).toBe('Private A');
    const [untouched] = await f.dbs.owner
      .select({ name: schema.properties.name })
      .from(schema.properties)
      .where(eq(schema.properties.id, id));
    expect(untouched?.name).toBe('Private A');
  });

  it('manages parcels and units and builds the overview', async () => {
    const ownerA = customerIdentity(f, 'A');
    const id = await insertProperty(f.dbs.owner, f.orgA, {
      name: 'Estate block',
      kind: 'residential',
    });
    const parcel = await createParcel(ownerA, id, {
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
    expect((await listParcels(ownerA, id)).map((p) => p.reference)).toEqual(['P1']);
    await expect(createParcel(customerIdentity(f, 'B'), id, { reference: 'P2' })).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await createUnit(ownerA, id, { label: 'A1', unitType: 'flat', status: 'occupied' });
    await createUnit(ownerA, id, { label: 'A2', unitType: 'flat', status: 'vacant' });
    await expect(
      createUnit(ownerA, id, { label: 'A1', unitType: 'flat', status: 'vacant' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'conflict');
    expect((await listUnits(ownerA, id)).map((u) => u.label)).toEqual(['A1', 'A2']);
    await f.dbs.owner
      .insert(schema.projects)
      .values({ organizationId: f.orgA, propertyId: id, name: 'Renovation', kind: 'renovation' });
    await insertFile(f.dbs.owner, f.orgA, f.ownerA).then((fileId) =>
      f.dbs.owner
        .update(schema.fileObjects)
        .set({ entityType: 'property', entityId: id })
        .where(eq(schema.fileObjects.id, fileId)),
    );
    const overview = await getPropertyOverview(ownerA, id);
    expect(overview.units).toEqual({
      total: 2,
      occupied: 1,
      vacant: 1,
      unavailable: 0,
      occupancyPercent: 50,
    });
    expect(overview.parcelsCount).toBe(1);
    expect(overview.linkedProjectsCount).toBe(1);
    expect(overview.documents).toEqual({ available: 1, pending: 0 });
    expect(overview.ownerAuthority).toBeNull();
    await expect(getPropertyOverview(customerIdentity(f, 'B'), id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
  });

  it('lets the customer submit an owner authority that only staff with rentals.manage can verify', async () => {
    const ownerA = customerIdentity(f, 'A');
    const id = await insertProperty(f.dbs.owner, f.orgA, { name: 'Listing candidate' });
    const foreignFile = await insertFile(f.dbs.owner, f.orgB, f.ownerB);
    await expect(
      submitOwnerAuthority(ownerA, id, {
        ownerName: 'Chief A',
        authorityDocumentFileId: foreignFile,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    const infected = await insertFile(f.dbs.owner, f.orgA, f.ownerA, 'infected');
    await expect(
      submitOwnerAuthority(ownerA, id, { ownerName: 'Chief A', authorityDocumentFileId: infected }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'file_quarantined');
    const file = await insertFile(f.dbs.owner, f.orgA, f.ownerA);
    const authority = await submitOwnerAuthority(ownerA, id, {
      ownerName: 'Chief A',
      authorityDocumentFileId: file,
    });
    expect(authority.status).toBe('pending');
    // The customer cannot verify their own authority; support lacks rentals.manage.
    await expect(verifyOwnerAuthority(ownerA, id, authority.id, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    await expect(verifyOwnerAuthority(supportIdentity(f), id, authority.id, {})).rejects.toSatisfy(
      (e) => errorCode(e) === 'forbidden',
    );
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const verified = await verifyOwnerAuthority(opsIdentity(f), id, authority.id, { expiresAt });
    expect(verified.status).toBe('verified');
    expect(verified.effectiveStatus).toBe('verified');
    expect(verified.verifiedBy).toBe(f.ops);
    await expect(
      rejectOwnerAuthority(opsIdentity(f), id, authority.id, { reason: 'late' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    // Expiry is derived from the date.
    await f.dbs.owner
      .update(schema.ownerAuthorities)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.ownerAuthorities.id, authority.id));
    const overview = await getPropertyOverview(ownerA, id);
    expect(overview.ownerAuthority?.effectiveStatus).toBe('expired');
  });
});
