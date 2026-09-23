import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';

// Anonymous visitor: the route must append with this ordinary context, not an elevated one.
vi.mock('@/lib/auth/session', () => ({
  getIdentity: async () => ({
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
    ctx: { userId: null, organizationId: null, staff: false, anonymousToken: null },
    profile: null,
    featureFlags: {},
  }),
}));

const { POST } = await import('./events/route');

let dbs: TestDatabases;

function request(body: unknown, cookie?: string, ip = '203.0.113.50'): Request {
  return new Request('http://localhost:3000/api/v1/analytics/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

const event = {
  eventName: 'page_view',
  path: '/services',
  props: { variant: 'homepage' },
  sessionId: 'session-abc-123456',
};

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('POST /api/v1/analytics/events', () => {
  it('refuses events without the analytics consent cookie', async () => {
    expect((await POST(request(event), {})).status).toBe(403);
    expect((await POST(request(event, 'sx_consent=essential'), {})).status).toBe(403);
    const rows = await dbs.owner.select().from(schema.analyticsEvents);
    expect(rows).toHaveLength(0);
  });

  it('stores consented events with a keyed session hash, never the raw session id', async () => {
    const res = await POST(request(event, 'sx_consent=analytics'), {});
    expect(res.status).toBe(202);
    const [row] = await dbs.owner
      .select()
      .from(schema.analyticsEvents)
      .orderBy(desc(schema.analyticsEvents.createdAt));
    expect(row!.eventName).toBe('page_view');
    expect(row!.path).toBe('/services');
    expect(row!.sessionHash).toHaveLength(32);
    expect(row!.sessionHash).not.toContain('session-abc');
    expect(row!.consentVersion).toBe('2026-09');
  });

  it('rejects payloads that carry an email-like string or a malformed event name', async () => {
    const withEmail = await POST(
      request({ ...event, props: { note: 'ada@example.com' } }, 'sx_consent=analytics'),
      {},
    );
    expect(withEmail.status).toBe(400);
    const badName = await POST(
      request({ ...event, eventName: 'Page View' }, 'sx_consent=analytics'),
      {},
    );
    expect(badName.status).toBe(400);
    const rows = await dbs.owner.select().from(schema.analyticsEvents);
    expect(rows).toHaveLength(1);
  });
});
