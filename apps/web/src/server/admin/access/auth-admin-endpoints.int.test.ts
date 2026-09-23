import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@simplexd/db';
import { GET, POST } from '@/app/api/auth/[...all]/route';

/**
 * The auth library's admin plugin endpoints (impersonation, role and ban
 * changes, user listing) must never be reachable over HTTP: staff
 * administration goes through the audited, MFA-gated /api/v1/admin routes.
 */

afterAll(async () => {
  await closeDb();
});

const base = 'http://localhost:3000/api/auth/admin';

describe('auth admin plugin endpoints', () => {
  it.each([
    ['POST', '/impersonate-user', { userId: 'someone' }],
    ['POST', '/set-role', { userId: 'someone', role: 'admin' }],
    ['POST', '/ban-user', { userId: 'someone' }],
    ['GET', '/list-users', undefined],
  ] as const)('refuses %s %s with 404', async (method, path, body) => {
    const request = new Request(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = method === 'GET' ? await GET(request) : await POST(request);
    expect(res.status).toBe(404);
  });

  it('still serves the ordinary session endpoint', async () => {
    const res = await GET(new Request('http://localhost:3000/api/auth/get-session'));
    expect(res.status).toBe(200);
  });
});
