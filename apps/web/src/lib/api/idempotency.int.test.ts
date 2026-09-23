import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyKeyHeader } from '@simplexd/contracts';
import { closeDb, schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import type { RequestIdentity } from '../auth/session';
import { idempotentReplayHeader, requestHash, withIdempotency } from './idempotency';

const ENDPOINT = 'POST /api/v1/test/orders';

function identityFor(userId: string | null, anonymousToken: string | null): RequestIdentity {
  return {
    session: userId
      ? ({ user: { id: userId }, session: { userId } } as unknown as RequestIdentity['session'])
      : null,
    actor: {
      userId,
      staffRoles: [],
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags: {},
    },
    ctx: { userId, organizationId: null, staff: false, anonymousToken },
    profile: null,
    featureFlags: {},
  };
}

function request(key: string | null): Request {
  const headers = new Headers();
  if (key) headers.set(idempotencyKeyHeader, key);
  return new Request('http://localhost/api/v1/test/orders', { method: 'POST', headers });
}

describe('withIdempotency', () => {
  let dbs: TestDatabases;
  let userId: string;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    userId = `user_${uniqueSuffix()}`;
    await dbs.owner.insert(schema.user).values({
      id: userId,
      name: 'Idempotency Tester',
      email: `${userId}@example.test`,
      emailVerified: true,
    });
  });

  afterAll(async () => {
    // Remove only this suite's rows: other suites share the test database.
    await dbs.owner
      .delete(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.requesterId, userId));
    await dbs.owner.delete(schema.user).where(eq(schema.user.id, userId));
    await dbs.close();
    await closeDb();
  });

  it('runs the handler once and replays the stored response for the same key and body', async () => {
    const identity = identityFor(userId, null);
    const key = `key-${uniqueSuffix()}`;
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return new Response(JSON.stringify({ orderId: 'o-1', calls }), {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };
    const first = await withIdempotency(
      request(key),
      identity,
      ENDPOINT,
      { amount: '100' },
      handler,
    );
    const second = await withIdempotency(
      request(key),
      identity,
      ENDPOINT,
      { amount: '100' },
      handler,
    );
    expect(calls).toBe(1);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get(idempotentReplayHeader)).toBe('true');
    expect(await second.json()).toEqual({ orderId: 'o-1', calls: 1 });
  });

  it('rejects the same key with a different body', async () => {
    const identity = identityFor(userId, null);
    const key = `key-${uniqueSuffix()}`;
    const handler = async () => Response.json({ ok: true });
    await withIdempotency(request(key), identity, ENDPOINT, { amount: '100' }, handler);
    await expect(
      withIdempotency(request(key), identity, ENDPOINT, { amount: '200' }, handler),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('scopes keys to the requester and endpoint', async () => {
    const key = `key-${uniqueSuffix()}`;
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return Response.json({ calls });
    };
    await withIdempotency(request(key), identityFor(userId, null), ENDPOINT, { a: 1 }, handler);
    await withIdempotency(
      request(key),
      identityFor(null, `anon${uniqueSuffix()}`),
      ENDPOINT,
      { a: 1 },
      handler,
    );
    await withIdempotency(
      request(key),
      identityFor(userId, null),
      'POST /api/v1/test/other',
      { a: 1 },
      handler,
    );
    expect(calls).toBe(3);
  });

  it('releases the key when the handler fails so the client can retry', async () => {
    const identity = identityFor(userId, null);
    const key = `key-${uniqueSuffix()}`;
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('provider down');
    };
    await expect(
      withIdempotency(request(key), identity, ENDPOINT, { a: 1 }, failing),
    ).rejects.toThrow('provider down');
    const res = await withIdempotency(request(key), identity, ENDPOINT, { a: 1 }, async () => {
      calls += 1;
      return Response.json({ ok: true });
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('does not store non-2xx responses', async () => {
    const identity = identityFor(userId, null);
    const key = `key-${uniqueSuffix()}`;
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return Response.json({ error: 'slot taken' }, { status: calls === 1 ? 409 : 200 });
    };
    const first = await withIdempotency(request(key), identity, ENDPOINT, { a: 1 }, handler);
    const second = await withIdempotency(request(key), identity, ENDPOINT, { a: 1 }, handler);
    expect(first.status).toBe(409);
    expect(second.status).toBe(200);
    expect(second.headers.get(idempotentReplayHeader)).toBeNull();
  });

  it('reports concurrent duplicates as retryable conflicts', async () => {
    const identity = identityFor(userId, null);
    const key = `key-${uniqueSuffix()}`;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      await gate;
      return Response.json({ ok: true });
    };
    const inFlight = withIdempotency(request(key), identity, ENDPOINT, { a: 1 }, slow);
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      withIdempotency(request(key), identity, ENDPOINT, { a: 1 }, slow),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true });
    release();
    expect((await inFlight).status).toBe(200);
  });

  it('enforces the header when required and validates its shape', async () => {
    const identity = identityFor(userId, null);
    const handler = async () => Response.json({ ok: true });
    await expect(
      withIdempotency(request(null), identity, ENDPOINT, {}, handler, { required: true }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      withIdempotency(request('short'), identity, ENDPOINT, {}, handler),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const res = await withIdempotency(request(null), identity, ENDPOINT, {}, handler);
    expect(res.status).toBe(200);
  });

  it('hashes bodies independently of key order', () => {
    expect(requestHash(ENDPOINT, { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      requestHash(ENDPOINT, { b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(requestHash(ENDPOINT, { a: 1 })).not.toBe(requestHash(ENDPOINT, { a: 2 }));
  });
});
