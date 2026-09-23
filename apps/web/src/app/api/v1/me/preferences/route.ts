import { eq } from 'drizzle-orm';
import { ApiError, profilePreferencesUpdateSchema } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { isValidTimeZone } from '@simplexd/domain/time';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

const patchSchema = profilePreferencesUpdateSchema.refine(
  (v) => v.timeZone === undefined || isValidTimeZone(v.timeZone),
  { message: 'unknown time zone', path: ['timeZone'] },
);

export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return json(identity.profile, { correlationId });
});

/** Persists the signed-in user's own preferences (theme, motion, time zone, goals). */
export const PATCH = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, patchSchema);
  const userId = identity.session.user.id;
  const updated = await withActor(getDb(), identity.ctx, async (tx) => {
    await tx.insert(schema.userProfiles).values({ userId }).onConflictDoNothing();
    const rows = await tx
      .update(schema.userProfiles)
      .set(body)
      .where(eq(schema.userProfiles.userId, userId))
      .returning();
    return rows[0];
  });
  return json(updated, { correlationId });
});
