import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import {
  ensureNotificationTemplates,
  getDevSmsProvider,
  type PipelineOptions,
} from '@simplexd/notifications';
import { customerIdentity } from '@/testing/identity';
import {
  PHONE_OTP_LIMITS,
  PHONE_OTP_PURPOSE,
  confirmPhoneVerification,
  requestPhoneVerification,
} from './phone-verification';

/**
 * Phone verification by SMS code: hashed storage, expiry, wrong-code limit,
 * per-user and per-number rate limits, suppression refusal and the verified
 * mark on success. The labelled development adapter is injected explicitly.
 */

const sfx = uniqueSuffix();
const sms = getDevSmsProvider('test');

let dbs: TestDatabases;

function phone(): string {
  // Random suffix per run so per-number limits from an earlier run cannot interfere.
  const n = String(Math.floor(Math.random() * 90_000_000) + 10_000_000);
  return `+23480${n.slice(0, 4)}${n.slice(4, 7)}9`;
}

async function person(label: string, number: string | null, verified = false) {
  const userId = `otp_${label}_${sfx}`;
  await dbs.owner
    .insert(schema.user)
    .values({ id: userId, name: `OTP ${label}`, email: `${userId}@example.test` });
  await dbs.owner.insert(schema.userProfiles).values({
    userId,
    phoneE164: number,
    phoneVerifiedAt: verified ? new Date() : null,
  });
  return customerIdentity({ userId, email: `${userId}@example.test`, organizationId: null });
}

function deps(now?: () => Date): { db: TestDatabases['app']; pipeline: PipelineOptions } {
  return { db: dbs.app, pipeline: { providers: { sms }, ...(now ? { now } : {}) } };
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

async function challengesFor(userId: string) {
  return dbs.owner
    .select()
    .from(schema.otpChallenges)
    .where(
      and(
        eq(schema.otpChallenges.purpose, PHONE_OTP_PURPOSE),
        like(schema.otpChallenges.subject, `${userId}|%`),
      ),
    );
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await ensureNotificationTemplates(dbs.owner);
});

afterAll(async () => {
  await dbs.close();
});

describe('request and confirm', () => {
  it('stores only a hash, sends through the labelled development adapter and marks the number verified on success', async () => {
    const number = phone();
    const me = await person('happy', number);
    const sent = await requestPhoneVerification(me, deps());
    expect(sent.status).toBe('sent');
    expect(sent.phoneMasked).toBe(`+234 ••• ••• ${number.slice(-4)}`);
    expect(sent.maxAttempts).toBe(PHONE_OTP_LIMITS.maxAttempts);
    expect(sent.delivery).toMatchObject({ adapter: 'dev', developmentAdapter: true });
    expect(sent.delivery?.label).toContain('Development adapter');
    const code = sent.delivery!.developmentCode!;
    expect(code).toMatch(/^\d{6}$/);

    const [challenge] = await challengesFor(me.session!.user.id);
    expect(challenge?.codeHash.startsWith('scrypt$')).toBe(true);
    expect(challenge?.codeHash).not.toContain(code);
    expect(sms.outbox.at(-1)).toMatchObject({ to: number, category: 'security' });
    expect(sms.outbox.at(-1)?.body).toContain(code);
    const [attempt] = await dbs.owner
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.relatedEntityId, challenge!.id));
    expect(attempt).toMatchObject({ status: 'accepted', relatedEntityType: 'otp_challenge' });
    expect(attempt?.subject).toBeNull();

    const wrong = await apiError(confirmPhoneVerification(me, { code: '000000' }, deps()));
    expect(wrong.code).toBe('validation_failed');
    expect(wrong.details).toEqual([
      expect.objectContaining({ path: 'code', reason: 'invalid_code', remainingAttempts: 4 }),
    ]);

    const ok = await confirmPhoneVerification(me, { code }, deps());
    expect(ok.phoneE164).toBe(number);
    const [profile] = await dbs.owner
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, me.session!.user.id));
    expect(profile?.phoneVerifiedAt).not.toBeNull();
    const audits = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, 'profile.phone_verified'),
          eq(schema.auditEvents.entityId, me.session!.user.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.after)).not.toContain(code);

    expect((await requestPhoneVerification(me, deps())).status).toBe('already_verified');
    const reused = await apiError(confirmPhoneVerification(me, { code }, deps()));
    expect(reused.details).toEqual([expect.objectContaining({ reason: 'no_active_code' })]);
  });

  it('locks the code after too many wrong attempts, even the right code afterwards', async () => {
    const me = await person('limit', phone());
    const sent = await requestPhoneVerification(me, deps());
    const code = sent.delivery!.developmentCode!;
    const wrongCode = code === '111111' ? '222222' : '111111';
    for (let i = 1; i < PHONE_OTP_LIMITS.maxAttempts; i += 1) {
      const err = await apiError(confirmPhoneVerification(me, { code: wrongCode }, deps()));
      expect(err.details).toEqual([
        expect.objectContaining({
          reason: 'invalid_code',
          remainingAttempts: PHONE_OTP_LIMITS.maxAttempts - i,
        }),
      ]);
    }
    const last = await apiError(confirmPhoneVerification(me, { code: wrongCode }, deps()));
    expect(last.details).toEqual([expect.objectContaining({ reason: 'too_many_attempts' })]);
    const right = await apiError(confirmPhoneVerification(me, { code }, deps()));
    expect(right.details).toEqual([expect.objectContaining({ reason: 'too_many_attempts' })]);
    const [challenge] = await challengesFor(me.session!.user.id);
    expect(challenge?.attempts).toBe(PHONE_OTP_LIMITS.maxAttempts);
  });

  it('rejects an expired code', async () => {
    const me = await person('expiry', phone());
    const sent = await requestPhoneVerification(me, deps());
    const later = new Date(Date.now() + (PHONE_OTP_LIMITS.ttlMinutes + 1) * 60_000);
    const err = await apiError(
      confirmPhoneVerification(
        me,
        { code: sent.delivery!.developmentCode! },
        deps(() => later),
      ),
    );
    expect(err.details).toEqual([expect.objectContaining({ reason: 'expired' })]);
  });

  it('refuses when the number changed after the code was sent', async () => {
    const me = await person('changed', phone());
    const sent = await requestPhoneVerification(me, deps());
    await dbs.owner
      .update(schema.userProfiles)
      .set({ phoneE164: phone(), phoneVerifiedAt: null })
      .where(eq(schema.userProfiles.userId, me.session!.user.id));
    const err = await apiError(
      confirmPhoneVerification(me, { code: sent.delivery!.developmentCode! }, deps()),
    );
    expect(err.code).toBe('conflict');
  });
});

describe('rate limits and refusals', () => {
  it('needs a saved number and enforces the resend cooldown', async () => {
    const none = await person('nophone', null);
    const missing = await apiError(requestPhoneVerification(none, deps()));
    expect(missing.code).toBe('validation_failed');

    const me = await person('cooldown', phone());
    await requestPhoneVerification(me, deps());
    const again = await apiError(requestPhoneVerification(me, deps()));
    expect(again.code).toBe('rate_limited');
    expect(again.retryAfterSeconds).toBeLessThanOrEqual(PHONE_OTP_LIMITS.resendCooldownSeconds);
    expect(again.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits codes per user per hour and only the newest code is usable', async () => {
    const me = await person('peruser', phone());
    const start = Date.now();
    const codes: string[] = [];
    for (let i = 0; i < PHONE_OTP_LIMITS.perUserPerHour; i += 1) {
      const at = new Date(start + i * (PHONE_OTP_LIMITS.resendCooldownSeconds + 1) * 1000);
      const sent = await requestPhoneVerification(
        me,
        deps(() => at),
      );
      codes.push(sent.delivery!.developmentCode!);
    }
    const at = new Date(
      start + PHONE_OTP_LIMITS.perUserPerHour * (PHONE_OTP_LIMITS.resendCooldownSeconds + 1) * 1000,
    );
    const limited = await apiError(
      requestPhoneVerification(
        me,
        deps(() => at),
      ),
    );
    expect(limited.code).toBe('rate_limited');
    expect(limited.message).toContain('too many codes requested');
    // Superseded codes are dead; the newest works.
    const old = await apiError(
      confirmPhoneVerification(
        me,
        { code: codes[0]! },
        deps(() => at),
      ),
    );
    expect(old.details).toEqual([expect.objectContaining({ reason: 'invalid_code' })]);
    if (codes[0] === codes.at(-1)) return; // astronomically unlikely collision; nothing more to check
    await confirmPhoneVerification(
      me,
      { code: codes.at(-1)! },
      deps(() => at),
    );
  });

  it('limits codes per number across users', async () => {
    const shared = phone();
    const a = await person('numA', shared);
    const b = await person('numB', shared);
    const c = await person('numC', shared);
    const start = Date.now();
    let step = 0;
    const next = () =>
      new Date(start + step++ * (PHONE_OTP_LIMITS.resendCooldownSeconds + 1) * 1000);
    for (let i = 0; i < 3; i += 1) {
      const at = next();
      await requestPhoneVerification(
        a,
        deps(() => at),
      );
    }
    for (let i = 0; i < PHONE_OTP_LIMITS.perNumberPerHour - 3; i += 1) {
      const at = next();
      await requestPhoneVerification(
        b,
        deps(() => at),
      );
    }
    const at = next();
    const limited = await apiError(
      requestPhoneVerification(
        c,
        deps(() => at),
      ),
    );
    expect(limited.code).toBe('rate_limited');
    expect(limited.message).toContain('this number');
  });

  it('refuses a number that replied STOP and does not leave a usable code behind', async () => {
    const number = phone();
    const me = await person('stopped', number);
    await dbs.owner.insert(schema.suppressions).values({
      channel: 'sms',
      address: number,
      reason: 'stop_keyword',
      source: 'test',
    });
    const before = sms.outbox.length;
    const err = await apiError(requestPhoneVerification(me, deps()));
    expect(err.code).toBe('conflict');
    expect(err.message).toContain('opted out');
    expect(sms.outbox.length).toBe(before);
    const [challenge] = await challengesFor(me.session!.user.id);
    expect(challenge?.consumedAt).not.toBeNull();
    const [attempt] = await dbs.owner
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.relatedEntityId, challenge!.id));
    expect(attempt).toMatchObject({
      status: 'suppressed',
      errorSanitized: 'suppressed:stop_keyword',
    });
  });

  it('reports a provider rejection honestly and consumes the code', async () => {
    // The development adapter rejects numbers ending in 0000.
    const me = await person('rejected', '+2348031230000');
    const err = await apiError(requestPhoneVerification(me, deps()));
    expect(err.code).toBe('provider_unavailable');
    expect(err.message).toContain('did not accept');
    const [challenge] = await challengesFor(me.session!.user.id);
    expect(challenge?.consumedAt).not.toBeNull();
  });
});
