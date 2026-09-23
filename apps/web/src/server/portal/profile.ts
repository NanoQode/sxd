import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { ApiError, type ConsentDto } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

/** Normalises free-form input to E.164 or throws a validation error. */
export function normalizePhone(input: string, defaultCountry: string): string {
  const parsed = parsePhoneNumberFromString(input, defaultCountry.toUpperCase() as CountryCode);
  if (!parsed || !parsed.isValid()) {
    throw new ApiError('validation_failed', 'enter a valid phone number, e.g. +234 801 234 5678', {
      details: [{ path: 'phone', message: 'invalid phone number' }],
    });
  }
  return parsed.number;
}

export async function updatePhone(
  identity: RequestIdentity,
  input: { phone: string | null; defaultCountry: string },
): Promise<{ phoneE164: string | null }> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const userId = identity.session.user.id;
  const phoneE164 = input.phone && input.phone.trim().length > 0 ? normalizePhone(input.phone, input.defaultCountry) : null;
  await withActor(getDb(), identity.ctx, async (tx) => {
    await tx.insert(schema.userProfiles).values({ userId }).onConflictDoNothing();
    const [current] = await tx
      .select({ phoneE164: schema.userProfiles.phoneE164 })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    await tx
      .update(schema.userProfiles)
      .set({
        phoneE164,
        // A changed number is unverified until an OTP flow (Wave 3) confirms it.
        ...(current?.phoneE164 !== phoneE164 ? { phoneVerifiedAt: null } : {}),
      })
      .where(eq(schema.userProfiles.userId, userId));
  });
  return { phoneE164 };
}

export async function completeOnboarding(
  identity: RequestIdentity,
  input: { goals?: string[] },
): Promise<{ onboardingCompletedAt: string }> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const userId = identity.session.user.id;
  const now = new Date();
  await withActor(getDb(), identity.ctx, async (tx) => {
    await tx.insert(schema.userProfiles).values({ userId }).onConflictDoNothing();
    await tx
      .update(schema.userProfiles)
      .set({ onboardingCompletedAt: now, ...(input.goals ? { goals: input.goals } : {}) })
      .where(eq(schema.userProfiles.userId, userId));
  });
  return { onboardingCompletedAt: now.toISOString() };
}

/** Append-only consent history for the signed-in user. */
export async function listConsents(identity: RequestIdentity): Promise<ConsentDto[]> {
  if (!identity.session) return [];
  const userId = identity.session.user.id;
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.consents)
      .where(eq(schema.consents.userId, userId))
      .orderBy(desc(schema.consents.recordedAt))
      .limit(200),
  );
  return rows.map((c) => ({
    id: c.id,
    purpose: c.purpose,
    granted: c.granted,
    policyVersion: c.policyVersion,
    source: c.source,
    recordedAt: c.recordedAt.toISOString(),
  }));
}
