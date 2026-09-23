import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';
import { schema, type Database } from '@simplexd/db';
import { importMarketSeed, seedReferenceData } from '@simplexd/db/seed';
import { anonymousActor, type StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Shared fixtures for the market read-model integration tests. Identities are
 * constructed directly (no HTTP, no better-auth) with the same shape
 * `getIdentity()` produces; the database is seeded with the research seed
 * and a subset of markets is published with the owner role.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = path.resolve(
  here,
  '../../../../../data/seed/nigeria-50-markets.seed.json',
);

export const PUBLISHED_SLUGS = [
  'ng-ibadan',
  'ng-lagos',
  'ng-ikeja',
  'ng-ikorodu',
  'ng-abuja',
  'ng-sagamu',
] as const;

export function readSeed(): unknown {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

/** Seeds reference data and the market seed, then publishes the subset and every interpretation. */
export async function seedAndPublish(owner: Database): Promise<void> {
  await seedReferenceData(owner);
  const summary = await importMarketSeed(owner, readSeed());
  if (summary.issues.length > 0 || summary.conflicts.length > 0) {
    throw new Error(
      `seed import failed: ${JSON.stringify({ issues: summary.issues, conflicts: summary.conflicts })}`,
    );
  }
  await owner
    .update(schema.markets)
    .set({ publicationState: 'published', publishedAt: new Date() })
    .where(inArray(schema.markets.slug, [...PUBLISHED_SLUGS]));
  await owner
    .update(schema.observationInterpretations)
    .set({ publicationState: 'published', publishedAt: new Date() });
}

export async function insertUser(owner: Database, id: string): Promise<void> {
  await owner.insert(schema.user).values({ id, name: id, email: `${id}@example.test` });
}

const defaultFlags = { 'core.anonymous_scenarios': true };

export function anonymousIdentity(
  anonymousToken: string | null,
  featureFlags: Record<string, boolean> = defaultFlags,
): RequestIdentity {
  return {
    session: null,
    actor: { ...anonymousActor, flags: featureFlags },
    ctx: { userId: null, organizationId: null, staff: false, anonymousToken },
    profile: null,
    featureFlags,
  };
}

function fakeSession(userId: string): RequestIdentity['session'] {
  const expiresAt = new Date(Date.now() + 3_600_000);
  return {
    user: { id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true },
    session: { id: `session_${userId}`, userId, expiresAt, token: `token_${userId}` },
  } as unknown as RequestIdentity['session'];
}

export function userIdentity(
  userId: string,
  anonymousToken: string | null = null,
  featureFlags: Record<string, boolean> = defaultFlags,
): RequestIdentity {
  return {
    session: fakeSession(userId),
    actor: {
      userId,
      staffRoles: [],
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: false,
      flags: featureFlags,
    },
    ctx: { userId, organizationId: null, staff: false, anonymousToken },
    profile: null,
    featureFlags,
  };
}

export function staffIdentity(
  userId: string,
  staffRoles: StaffRole[] = ['data_approver'],
  featureFlags: Record<string, boolean> = defaultFlags,
): RequestIdentity {
  return {
    session: fakeSession(userId),
    actor: {
      userId,
      staffRoles,
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: true,
      flags: featureFlags,
    },
    ctx: { userId, organizationId: null, staff: true, anonymousToken: null },
    profile: null,
    featureFlags,
  };
}
