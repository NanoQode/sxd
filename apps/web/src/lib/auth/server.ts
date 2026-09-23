import 'server-only';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { appendOutbox, getDb, schema, systemContext, withActor } from '@simplexd/db';
import { env, isDevelopmentLike, trustedOrigins } from '../env';
import { logger } from '../logger';

/**
 * Identity, sessions, credentials, organisations and MFA are delegated to
 * better-auth. Authorisation is ours (see lib/auth/session.ts and
 * @simplexd/domain/authz). Emails are sent through the transactional outbox so
 * delivery is durable and provider-agnostic.
 */

function queueEmail(kind: string, payload: Record<string, unknown>): Promise<void> {
  const db = getDb();
  return withActor(db, systemContext(), async (tx) => {
    await appendOutbox(tx, {
      eventType: 'notification.requested',
      aggregateType: 'auth',
      aggregateId: String(payload['userId'] ?? payload['email'] ?? 'unknown'),
      payload: { kind, channel: 'email', category: 'security', ...payload },
    });
  });
}

const e = env();
const db = getDb();

export const auth = betterAuth({
  appName: e.APP_NAME,
  baseURL: e.APP_URL,
  secret: e.AUTH_SECRET,
  trustedOrigins: trustedOrigins(),
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
      twoFactor: schema.twoFactor,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 256,
    requireEmailVerification: !isDevelopmentLike(),
    sendResetPassword: async ({ user, url }) => {
      await queueEmail('password_reset', {
        userId: user.id,
        email: user.email,
        name: user.name,
        resetUrl: url,
        expiresIn: '1 hour',
      });
    },
    resetPasswordTokenExpiresIn: 3600,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await queueEmail('email_verification', {
        userId: user.id,
        email: user.email,
        name: user.name,
        verifyUrl: url,
      });
    },
  },
  session: {
    expiresIn: e.AUTH_SESSION_MAX_AGE,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 3600, max: 10 },
      '/request-password-reset': { window: 3600, max: 5 },
      '/two-factor/verify-totp': { window: 300, max: 10 },
    },
  },
  advanced: {
    cookiePrefix: 'sx',
    useSecureCookies: e.APP_URL.startsWith('https://'),
    defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, path: '/' },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await withActor(db, systemContext(), async (tx) => {
              await tx
                .insert(schema.userProfiles)
                .values({ userId: user.id })
                .onConflictDoNothing();
              await tx.insert(schema.auditEvents).values({
                actorType: 'user',
                actorUserId: user.id,
                action: 'user.created',
                entityType: 'user',
                entityId: user.id,
                after: { email: user.email },
              });
            });
          } catch (err) {
            logger().error({ err }, 'failed to create user profile');
          }
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 10,
      creatorRole: 'owner',
      membershipLimit: 200,
      invitationExpiresIn: 60 * 60 * 24 * 7,
      sendInvitationEmail: async (data) => {
        await queueEmail('invitation', {
          email: data.email,
          inviterName: data.inviter.user.name,
          organizationName: data.organization.name,
          role: data.role,
          invitationId: data.id,
          inviteUrl: `${e.APP_URL}/invitations/${data.id}`,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        });
        await withActor(db, systemContext(), async (tx) => {
          await appendOutbox(tx, {
            eventType: 'invitation.created',
            aggregateType: 'invitation',
            aggregateId: data.id,
            organizationId: data.organization.id,
            payload: { email: data.email, role: data.role },
          });
        });
      },
      organizationCreation: {
        afterCreate: async ({ organization: org }: { organization: { id: string } }) => {
          await withActor(db, systemContext(), async (tx) => {
            await tx
              .insert(schema.organizationProfiles)
              .values({ organizationId: org.id, kind: 'customer' })
              .onConflictDoNothing();
          });
        },
      },
    }),
    twoFactor({
      issuer: e.APP_NAME,
      skipVerificationOnEnable: false,
      totpOptions: { digits: 6, period: 30 },
      backupCodeOptions: { amount: 10, length: 10 },
    }),
    admin({ defaultRole: 'user', impersonationSessionDuration: 60 * 30 }),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
export type Session = Auth['$Infer']['Session'];

/** Looks up a user's email address (used by notification handlers). */
export async function findUserEmail(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return rows[0]?.email ?? null;
}
