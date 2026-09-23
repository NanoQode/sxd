import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb } from '@simplexd/db';
import type * as AuthzModule from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Route handlers of the property-management API: expansion endpoints answer
 * 404 `feature_disabled` while their flag is off (route gate and service gate
 * alike), tenant endpoints need a session, staff-only endpoints refuse owners.
 */

const mocks = vi.hoisted(() => ({ identity: null as RequestIdentity | null }));

vi.mock('@/lib/auth/session', async () => {
  const { ApiError } = await import('@simplexd/contracts');
  const authz: typeof AuthzModule = await import('@simplexd/domain/authz');
  const { authorizeStaff } = authz;
  const anonymous = {
    session: null,
    actor: {
      userId: null,
      staffRoles: [],
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags: {},
    },
    ctx: { userId: null, organizationId: null, staff: false },
    profile: null,
    featureFlags: {},
  };
  const current = () => mocks.identity ?? (anonymous as unknown as RequestIdentity);
  return {
    getIdentity: async () => current(),
    requireStaff: async (permission: Parameters<typeof authorizeStaff>[1]) => {
      const identity = current();
      if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
      authz.assertAllowed(authorizeStaff(identity.actor, permission));
      return identity;
    },
  };
});

const { ALL_FLAGS, createRentalFixture, opsIdentity, ownerIdentity } =
  await import('./testing/fixtures');
const assetsRoute = await import('@/app/api/v1/assets/route');
const estatesRoute = await import('@/app/api/v1/estates/route');
const staysRoute = await import('@/app/api/v1/rent/stays/route');
const tenantLeasesRoute = await import('@/app/api/v1/tenant/leases/route');
const leasesRoute = await import('@/app/api/v1/leases/route');
const invoicingRoute = await import('@/app/api/v1/rent/invoicing-runs/route');

type Fixture = Awaited<ReturnType<typeof createRentalFixture>>;
let f: Fixture;

beforeAll(async () => {
  f = await createRentalFixture();
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

function get(path: string): Request {
  return new Request(`http://localhost:3000${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe('property management routes', () => {
  it('answers feature_disabled on expansion endpoints while the flag is off', async () => {
    mocks.identity = ownerIdentity(f, 'A');
    const assets = await assetsRoute.GET(get('/api/v1/assets'), {});
    expect(assets.status).toBe(404);
    expect(await errorOf(assets)).toBe('feature_disabled');
    const estates = await estatesRoute.GET(get('/api/v1/estates'), {});
    expect(estates.status).toBe(404);
    expect(await errorOf(estates)).toBe('feature_disabled');
    const stay = await staysRoute.POST(
      post('/api/v1/rent/stays', {
        propertyId: f.propertyA,
        guestName: 'Guest',
        checkIn: '2026-05-01',
        checkOut: '2026-05-03',
        nightlyRateKobo: '5000000',
      }),
      {},
    );
    expect(stay.status).toBe(404);
    expect(await errorOf(stay)).toBe('feature_disabled');
  });

  it('serves the expansion endpoints once the flag is on for the caller', async () => {
    mocks.identity = ownerIdentity(f, 'A', ALL_FLAGS);
    const assets = await assetsRoute.GET(get('/api/v1/assets'), {});
    expect(assets.status).toBe(200);
    expect(await assets.json()).toEqual({ items: [], nextCursor: null });
    const estates = await estatesRoute.GET(get('/api/v1/estates'), {});
    expect(estates.status).toBe(200);
  });

  it('requires a session for the tenant portal and staff rights for the rent job', async () => {
    mocks.identity = null;
    const tenant = await tenantLeasesRoute.GET(get('/api/v1/tenant/leases'), {});
    expect(tenant.status).toBe(401);
    const leases = await leasesRoute.GET(get('/api/v1/leases'), {});
    expect(leases.status).toBe(401);

    mocks.identity = ownerIdentity(f, 'A');
    expect((await leasesRoute.GET(get('/api/v1/leases?limit=5'), {})).status).toBe(200);
    const denied = await invoicingRoute.POST(post('/api/v1/rent/invoicing-runs', {}), {});
    expect(denied.status).toBe(403);

    mocks.identity = opsIdentity(f);
    const run = await invoicingRoute.POST(
      post('/api/v1/rent/invoicing-runs', { asOf: '2026-01-01' }),
      {},
    );
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ leases: 0, invoiced: 0, failures: [] });
  });
});
