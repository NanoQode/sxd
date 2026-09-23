import 'server-only';
import { and, desc, eq, gte, isNull, like, sql } from 'drizzle-orm';
import { ApiError, type PhoneVerificationRequestResponse } from '@simplexd/contracts';
import { getDb, schema, systemContext, withActor, type Database } from '@simplexd/db';
import { createOtpChallenge, verifyOtpAttempt } from '@simplexd/integrations/sms';
import { dispatchRequest, maskAddress, type PipelineOptions } from '@simplexd/notifications';
import type { RequestIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';

/**
 * Phone verification for the signed-in user (brief §10 optional phone, §13
 * OTP rules). The code is sent to the number saved on the profile through the
 * configured SMS provider (the labelled development adapter outside
 * production). Only a scrypt hash is stored in `otp_challenges`; the code is
 * never logged, audited or kept in a delivery attempt. Codes expire, allow a
 * limited number of wrong guesses, and requests are rate limited per user and
 * per number from the durable challenge rows (no in-memory state).
 */

export const PHONE_OTP_PURPOSE = 'phone_verification';

export const PHONE_OTP_LIMITS = {
  ttlMinutes: 10,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  perUserPerHour: 5,
  perNumberPerHour: 5,
  perNumberPerDay: 10,
} as const;

const DEV_LABEL = 'Development adapter — no real message was sent.';

export interface PhoneVerificationDeps {
  db?: Database;
  /** Pipeline overrides (tests inject providers and clocks). */
  pipeline?: PipelineOptions;
}

function pipelineFor(deps: PhoneVerificationDeps): PipelineOptions {
  const e = env();
  return { appEnv: e.APP_ENV, appUrl: e.APP_URL, brandName: e.APP_NAME, ...deps.pipeline };
}

function nowOf(options: PipelineOptions): Date {
  return options.now ? options.now() : new Date();
}

const subjectFor = (userId: string, phoneE164: string) => `${userId}|${phoneE164}`;

function userIdOf(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

async function loadProfilePhone(
  db: Database,
  identity: RequestIdentity,
  userId: string,
): Promise<{ phoneE164: string | null; phoneVerifiedAt: Date | null }> {
  const [row] = await withActor(db, identity.ctx, (tx) =>
    tx
      .select({
        phoneE164: schema.userProfiles.phoneE164,
        phoneVerifiedAt: schema.userProfiles.phoneVerifiedAt,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId)),
  );
  return { phoneE164: row?.phoneE164 ?? null, phoneVerifiedAt: row?.phoneVerifiedAt ?? null };
}

function retryAfter(oldest: Date | null, windowSeconds: number, now: Date): number {
  if (!oldest) return windowSeconds;
  return Math.max(1, Math.ceil((oldest.getTime() + windowSeconds * 1000 - now.getTime()) / 1000));
}

/** Plain-language refusal for an SMS the pipeline did not hand to a provider. */
function sendFailure(reason: string | null): ApiError {
  const r = reason ?? 'unknown';
  if (r.startsWith('suppressed:'))
    return new ApiError(
      'conflict',
      'This number has opted out of SMS from us (for example by replying STOP). Reply START to our sender ID, or contact support, then request a new code.',
      { details: { reason: r } },
    );
  if (r === 'provider_not_configured' || r.startsWith('template_') || r === 'purpose_disabled')
    return new ApiError(
      'provider_not_configured',
      'Sending verification codes by SMS is not set up yet. Please try again later.',
      { details: { reason: r } },
    );
  if (r === 'spend_cap_reached')
    return new ApiError(
      'provider_unavailable',
      'SMS sending is paused for today. Please try again tomorrow.',
      { details: { reason: r } },
    );
  return new ApiError(
    'provider_unavailable',
    `The SMS provider did not accept the message (${r.slice(0, 160)}). Please try again shortly.`,
    { details: { reason: r } },
  );
}

/**
 * Sends a new 6-digit code to the saved profile number. Refuses when no
 * number is saved, when it is already verified (answers `already_verified`)
 * and when a per-user or per-number limit is reached (429 with Retry-After).
 */
export async function requestPhoneVerification(
  identity: RequestIdentity,
  deps: PhoneVerificationDeps = {},
): Promise<PhoneVerificationRequestResponse> {
  const userId = userIdOf(identity);
  const db = deps.db ?? getDb();
  const pipeline = pipelineFor(deps);
  const now = nowOf(pipeline);
  const profile = await loadProfilePhone(db, identity, userId);
  const phone = profile.phoneE164;
  if (!phone) {
    throw new ApiError('validation_failed', 'save a phone number before verifying it', {
      details: [{ path: 'phone', message: 'no phone number on your profile' }],
    });
  }
  if (profile.phoneVerifiedAt) {
    return {
      status: 'already_verified',
      phoneMasked: maskAddress('sms', phone),
      expiresAt: null,
      resendAvailableAt: null,
      maxAttempts: null,
      delivery: null,
    };
  }

  // Rate limits and the new challenge, serialised per user and per number.
  const challenge = await withActor(db, systemContext(identity.ctx.correlationId), async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`otp-user:${userId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`otp-phone:${phone}`}))`);
    const t = schema.otpChallenges;
    const hourAgo = new Date(now.getTime() - 3600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const stats = async (pattern: string, since: Date) => {
      const [row] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${t.createdAt})`,
          newest: sql<Date | null>`max(${t.createdAt})`,
        })
        .from(t)
        .where(
          and(eq(t.purpose, PHONE_OTP_PURPOSE), like(t.subject, pattern), gte(t.createdAt, since)),
        );
      return {
        n: row?.n ?? 0,
        oldest: row?.oldest ? new Date(row.oldest) : null,
        newest: row?.newest ? new Date(row.newest) : null,
      };
    };
    const userHour = await stats(`${userId}|%`, hourAgo);
    const cooldownEnds = userHour.newest
      ? new Date(userHour.newest.getTime() + PHONE_OTP_LIMITS.resendCooldownSeconds * 1000)
      : null;
    if (cooldownEnds && cooldownEnds > now) {
      return {
        limited: true as const,
        message: 'a code was sent moments ago; wait before requesting another',
        retryAfterSeconds: Math.ceil((cooldownEnds.getTime() - now.getTime()) / 1000),
      };
    }
    if (userHour.n >= PHONE_OTP_LIMITS.perUserPerHour) {
      return {
        limited: true as const,
        message: 'too many codes requested; try again later',
        retryAfterSeconds: retryAfter(userHour.oldest, 3600, now),
      };
    }
    const phonePattern = `%|${phone}`;
    const numberHour = await stats(phonePattern, hourAgo);
    const numberDay = await stats(phonePattern, dayAgo);
    if (numberHour.n >= PHONE_OTP_LIMITS.perNumberPerHour) {
      return {
        limited: true as const,
        message: 'too many codes were sent to this number; try again later',
        retryAfterSeconds: retryAfter(numberHour.oldest, 3600, now),
      };
    }
    if (numberDay.n >= PHONE_OTP_LIMITS.perNumberPerDay) {
      return {
        limited: true as const,
        message: 'too many codes were sent to this number today; try again tomorrow',
        retryAfterSeconds: retryAfter(numberDay.oldest, 86_400, now),
      };
    }
    // Only the newest code for a user is usable.
    await tx
      .update(t)
      .set({ consumedAt: now })
      .where(
        and(eq(t.purpose, PHONE_OTP_PURPOSE), like(t.subject, `${userId}|%`), isNull(t.consumedAt)),
      );
    const otp = createOtpChallenge({
      now,
      ttlMinutes: PHONE_OTP_LIMITS.ttlMinutes,
      maxAttempts: PHONE_OTP_LIMITS.maxAttempts,
    });
    const [row] = await tx
      .insert(t)
      .values({
        purpose: PHONE_OTP_PURPOSE,
        subject: subjectFor(userId, phone),
        codeHash: otp.codeHash,
        maxAttempts: otp.maxAttempts,
        expiresAt: otp.expiresAt,
        createdAt: now,
      })
      .returning({ id: t.id });
    return { limited: false as const, id: row!.id, code: otp.code, expiresAt: otp.expiresAt };
  });
  if (challenge.limited) {
    throw new ApiError('rate_limited', challenge.message, {
      retryAfterSeconds: challenge.retryAfterSeconds,
    });
  }

  const result = await dispatchRequest(
    db,
    {
      templateKey: 'otp',
      category: 'security',
      channels: ['sms'],
      recipients: [{ userId, phone }],
      variables: { code: challenge.code, expiresIn: `${PHONE_OTP_LIMITS.ttlMinutes} minutes` },
      dedupeScope: `otp:${challenge.id}`,
      relatedEntity: { type: 'otp_challenge', id: challenge.id },
      // The code message is what verifies the number.
      allowUnverifiedPhone: true,
      correlationId: identity.ctx.correlationId ?? null,
    },
    pipeline,
  );
  const outcome = result.outcomes[0] ?? null;
  const accepted = outcome && (outcome.status === 'accepted' || outcome.status === 'sent');
  const [attempt] = outcome?.attemptId
    ? await withActor(db, systemContext('phone-verification'), (tx) =>
        tx
          .select({
            provider: schema.deliveryAttempts.provider,
            status: schema.deliveryAttempts.status,
          })
          .from(schema.deliveryAttempts)
          .where(eq(schema.deliveryAttempts.id, outcome.attemptId!)),
      )
    : [];

  await withActor(db, systemContext(identity.ctx.correlationId), async (tx) => {
    if (!accepted) {
      // The code never left; it must not stay usable.
      await tx
        .update(schema.otpChallenges)
        .set({ consumedAt: now })
        .where(eq(schema.otpChallenges.id, challenge.id));
      // A transient provider error leaves the attempt queued, but nothing will resend a code.
      if (outcome?.attemptId && attempt?.status === 'queued') {
        await tx
          .update(schema.deliveryAttempts)
          .set({ status: 'failed', failedAt: now })
          .where(eq(schema.deliveryAttempts.id, outcome.attemptId));
      }
    }
    await tx.insert(schema.auditEvents).values({
      actorType: 'user',
      actorUserId: userId,
      action: 'profile.phone_verification.requested',
      entityType: 'user',
      entityId: userId,
      after: {
        phone: maskAddress('sms', phone),
        attemptId: outcome?.attemptId ?? null,
        status: outcome?.status ?? 'skipped',
        reason: accepted ? null : (outcome?.reason ?? 'no_outcome'),
      },
      correlationId: identity.ctx.correlationId ?? null,
    });
  });
  if (!accepted) throw sendFailure(outcome?.reason ?? null);

  const adapter = attempt?.provider ?? 'unknown';
  const development = adapter === 'dev';
  const appEnv = pipeline.appEnv ?? 'development';
  return {
    status: 'sent',
    phoneMasked: maskAddress('sms', phone),
    expiresAt: challenge.expiresAt.toISOString(),
    resendAvailableAt: new Date(
      now.getTime() + PHONE_OTP_LIMITS.resendCooldownSeconds * 1000,
    ).toISOString(),
    maxAttempts: PHONE_OTP_LIMITS.maxAttempts,
    delivery: {
      adapter,
      developmentAdapter: development,
      label: development
        ? DEV_LABEL
        : 'Sent through the SMS provider. It usually arrives within a minute.',
      developmentCode:
        development && (appEnv === 'development' || appEnv === 'test') ? challenge.code : null,
    },
  };
}

type VerifyOutcome =
  { ok: true; phoneE164: string; verifiedAt: Date } | { ok: false; error: ApiError };

function codeError(message: string, reason: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError('validation_failed', message, {
    details: [{ path: 'code', message, reason, ...extra }],
  });
}

/**
 * Checks a code against the newest open challenge. Wrong codes count against
 * the attempt limit even though the request fails (the increment commits
 * before the error is raised). Success marks the profile number verified.
 */
export async function confirmPhoneVerification(
  identity: RequestIdentity,
  input: { code: string },
  deps: PhoneVerificationDeps = {},
): Promise<{ phoneE164: string; phoneVerifiedAt: string }> {
  const userId = userIdOf(identity);
  const db = deps.db ?? getDb();
  const pipeline = pipelineFor(deps);
  const now = nowOf(pipeline);
  const profile = await loadProfilePhone(db, identity, userId);

  const result: VerifyOutcome = await withActor(
    db,
    systemContext(identity.ctx.correlationId),
    async (tx) => {
      const t = schema.otpChallenges;
      const [challenge] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.purpose, PHONE_OTP_PURPOSE),
            like(t.subject, `${userId}|%`),
            isNull(t.consumedAt),
          ),
        )
        .orderBy(desc(t.createdAt))
        .limit(1)
        .for('update');
      if (!challenge) {
        return {
          ok: false,
          error: codeError('There is no active code. Request a new code.', 'no_active_code'),
        };
      }
      const phone = challenge.subject.slice(challenge.subject.indexOf('|') + 1);
      if (profile.phoneE164 !== phone) {
        await tx.update(t).set({ consumedAt: now }).where(eq(t.id, challenge.id));
        return {
          ok: false,
          error: new ApiError(
            'conflict',
            'Your phone number changed after the code was sent. Request a new code.',
            { details: { reason: 'phone_changed' } },
          ),
        };
      }
      const check = verifyOtpAttempt({
        storedHash: challenge.codeHash,
        code: input.code,
        attempts: challenge.attempts,
        maxAttempts: challenge.maxAttempts,
        expiresAt: challenge.expiresAt,
        consumedAt: challenge.consumedAt,
        now,
      });
      if (check.ok) {
        await tx.update(t).set({ consumedAt: now }).where(eq(t.id, challenge.id));
        await tx
          .update(schema.userProfiles)
          .set({ phoneVerifiedAt: now })
          .where(
            and(eq(schema.userProfiles.userId, userId), eq(schema.userProfiles.phoneE164, phone)),
          );
        await tx.insert(schema.auditEvents).values({
          actorType: 'user',
          actorUserId: userId,
          action: 'profile.phone_verified',
          entityType: 'user',
          entityId: userId,
          after: { phone: maskAddress('sms', phone), verifiedAt: now.toISOString() },
          correlationId: identity.ctx.correlationId ?? null,
        });
        return { ok: true, phoneE164: phone, verifiedAt: now };
      }
      const attempts = challenge.attempts + (check.countAttempt ? 1 : 0);
      if (check.countAttempt) {
        await tx.update(t).set({ attempts }).where(eq(t.id, challenge.id));
      }
      const remaining = Math.max(0, challenge.maxAttempts - attempts);
      if (check.reason === 'expired') {
        return {
          ok: false,
          error: codeError('This code has expired. Request a new code.', 'expired'),
        };
      }
      if (check.reason === 'too_many_attempts' || remaining === 0) {
        if (check.countAttempt) {
          await tx.insert(schema.auditEvents).values({
            actorType: 'user',
            actorUserId: userId,
            action: 'profile.phone_verification.locked',
            entityType: 'user',
            entityId: userId,
            after: { phone: maskAddress('sms', phone), attempts },
            correlationId: identity.ctx.correlationId ?? null,
          });
        }
        return {
          ok: false,
          error: codeError('Too many incorrect codes. Request a new code.', 'too_many_attempts'),
        };
      }
      return {
        ok: false,
        error: codeError(
          `That code is not correct. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left.`,
          'invalid_code',
          { remainingAttempts: remaining },
        ),
      };
    },
  );
  if (!result.ok) throw result.error;
  return { phoneE164: result.phoneE164, phoneVerifiedAt: result.verifiedAt.toISOString() };
}
