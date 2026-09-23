import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { seedReferenceData } from '@simplexd/db/seed';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';

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

const { POST } = await import('./consultation/route');

let dbs: TestDatabases;

function request(body: unknown, ip = '203.0.113.10'): Request {
  return new Request('http://localhost:3000/api/v1/leads/consultation', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'user-agent': 'vitest' },
    body: JSON.stringify(body),
  });
}

const base = {
  contactName: 'Ada Obi',
  email: 'ada@example.test',
  phoneE164: '+2348012345678',
  countryOfResidence: 'GB',
  timeZone: 'Europe/London',
  goal: 'buy_safely',
  serviceSlug: 'due-diligence',
  message: 'Plot in Epe.',
  marketingConsent: true,
  elapsedMs: 8000,
  source: 'consultation_booking',
};

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await seedReferenceData(dbs.owner);
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('POST /api/v1/leads/consultation', () => {
  it('stores a lead with the selected service, consent and hashed IP, and returns only a reference', async () => {
    const res = await POST(request(base), {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('received');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();

    const [lead] = await dbs.owner.select().from(schema.leads).where(eq(schema.leads.id, body.id));
    expect(lead).toBeDefined();
    expect(lead!.status).toBe('new');
    expect(lead!.email).toBe('ada@example.test');
    expect(lead!.source).toBe('consultation_booking');
    expect(lead!.timeZone).toBe('Europe/London');
    expect(lead!.interestServiceId).not.toBeNull();
    expect(lead!.ipHash).toHaveLength(24);
    expect(lead!.ipHash).not.toContain('203.0.113');
    const consents = await dbs.owner
      .select()
      .from(schema.consents)
      .where(eq(schema.consents.subjectEmail, 'ada@example.test'));
    expect(consents).toHaveLength(1);
    expect(consents[0]!.purpose).toBe('marketing_email');
  });

  it('marks honeypot submissions for review without revealing the classification', async () => {
    const res = await POST(
      request(
        { ...base, email: 'bot@example.test', website: 'http://spam.example' },
        '203.0.113.11',
      ),
      {},
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('received');
    const [lead] = await dbs.owner.select().from(schema.leads).where(eq(schema.leads.id, body.id));
    expect(lead!.status).toBe('spam');
  });

  it('rejects invalid payloads with field details and a stable error code', async () => {
    const res = await POST(
      request({ ...base, email: 'not-an-email', phoneE164: '0801' }, '203.0.113.12'),
      {},
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: Array<{ path: string }> };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.map((d) => d.path)).toEqual(
      expect.arrayContaining(['email', 'phoneE164']),
    );
  });

  it('limits one email address to three requests per hour', async () => {
    const email = 'repeat@example.test';
    for (let i = 0; i < 3; i += 1) {
      const res = await POST(
        request({ ...base, email, marketingConsent: false }, `198.51.100.${i + 1}`),
        {},
      );
      expect(res.status).toBe(201);
    }
    const blocked = await POST(
      request({ ...base, email, marketingConsent: false }, '198.51.100.9'),
      {},
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const body = (await blocked.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryable).toBe(true);
  });

  it('limits one connection to five requests per hour', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < 5; i += 1) {
      const res = await POST(
        request({ ...base, email: `ip${i}@example.test`, marketingConsent: false }, ip),
        {},
      );
      expect(res.status).toBe(201);
    }
    const blocked = await POST(
      request({ ...base, email: 'ip-last@example.test', marketingConsent: false }, ip),
      {},
    );
    expect(blocked.status).toBe(429);
  });

  it('records an unknown scenario as not found instead of storing a dangling reference', async () => {
    const res = await POST(
      request(
        {
          ...base,
          email: 'scenario@example.test',
          scenarioId: '7f1c4c4e-8c29-4e3d-9f5b-2a1c0f1d2e3a',
          source: 'website_form',
        },
        '203.0.113.13',
      ),
      {},
    );
    expect(res.status).toBe(404);
  });
});
