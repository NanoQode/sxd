import fs from 'node:fs';
import path from 'node:path';
import { request, type FullConfig } from '@playwright/test';

/**
 * Signs each demo role in once and stores its session for the journeys. The
 * sign-in endpoint is rate limited (ten attempts a minute per address), so
 * tests reuse these sessions instead of signing in for every page.
 */

export const DEMO_PASSWORD = 'DemoPassword-2026!';
export const AUTH_DIR = path.join(import.meta.dirname, '.auth');
export const ROLES = {
  owner: 'owner@demo.simplexd.local',
  tenant: 'tenant@demo.simplexd.local',
  contractor: 'contractor@demo.simplexd.local',
  admin: 'admin@demo.simplexd.local',
} as const;
export type DemoRole = keyof typeof ROLES;

export function storageStateFor(role: DemoRole): string {
  return path.join(AUTH_DIR, `${role}.json`);
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('baseURL is not configured');
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const [role, email] of Object.entries(ROLES) as [DemoRole, string][]) {
    const context = await request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: new URL(baseURL).origin },
    });
    const res = await context.post('/api/auth/sign-in/email', {
      data: { email, password: DEMO_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(
        `demo sign-in failed for ${email} (${res.status()}); run pnpm --filter @simplexd/web seed:demo`,
      );
    }
    await context.storageState({ path: storageStateFor(role) });
    await context.dispose();
  }
}
