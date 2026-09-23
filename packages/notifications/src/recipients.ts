import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type DbExecutor } from '@simplexd/db';
import { normalizeToE164 } from '@simplexd/integrations/sms';
import type { RecipientSpec, ResolvedRecipient } from './types';

const DEFAULT_TIME_ZONE = 'Africa/Lagos';

function normalizePhone(value: string | null | undefined): string | null {
  const result = normalizeToE164(value);
  return result.ok ? result.e164 : null;
}

/**
 * Turns recipient specs into concrete people: user rows supply email and
 * name, profiles supply phone, time zone, locale and marketing consent.
 * Explicit spec values win over stored ones (e.g. a lead's phone entered on
 * a form). Duplicate users are merged; specs without any address are dropped.
 */
export async function resolveRecipients(
  tx: DbExecutor,
  specs: RecipientSpec[],
): Promise<ResolvedRecipient[]> {
  const userIds = [...new Set(specs.map((s) => s.userId).filter((v): v is string => Boolean(v)))];
  const users = userIds.length
    ? await tx
        .select({
          id: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
          banned: schema.user.banned,
        })
        .from(schema.user)
        .where(inArray(schema.user.id, userIds))
    : [];
  const profiles = userIds.length
    ? await tx
        .select()
        .from(schema.userProfiles)
        .where(inArray(schema.userProfiles.userId, userIds))
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const profileById = new Map(profiles.map((p) => [p.userId, p]));
  const out = new Map<string, ResolvedRecipient>();
  for (const spec of specs) {
    const user = spec.userId ? userById.get(spec.userId) : undefined;
    if (spec.userId && !user) continue;
    if (user?.banned) continue;
    const profile = spec.userId ? profileById.get(spec.userId) : undefined;
    const email = (spec.email ?? user?.email ?? null)?.trim().toLowerCase() || null;
    const phoneE164 = normalizePhone(spec.phone) ?? profile?.phoneE164 ?? null;
    if (!user && !email && !phoneE164) continue;
    const key = user ? `user:${user.id}` : `addr:${email ?? phoneE164}`;
    const existing = out.get(key);
    const resolved: ResolvedRecipient = {
      userId: user?.id ?? null,
      email: existing?.email ?? email,
      phoneE164: existing?.phoneE164 ?? phoneE164,
      name: spec.name?.trim() || user?.name || existing?.name || email || 'there',
      timeZone: spec.timeZone ?? profile?.timeZone ?? existing?.timeZone ?? DEFAULT_TIME_ZONE,
      locale: (spec.locale ?? profile?.locale ?? existing?.locale ?? 'en').split('-')[0] ?? 'en',
      marketingConsentAt: profile?.marketingConsentAt ?? existing?.marketingConsentAt ?? null,
    };
    out.set(key, resolved);
  }
  return [...out.values()];
}

/** Members of a customer organisation, optionally limited to roles. */
export async function organizationMemberSpecs(
  tx: DbExecutor,
  organizationId: string,
  roles?: string[],
): Promise<RecipientSpec[]> {
  const rows = await tx
    .select({ userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));
  return rows
    .filter(
      (r) => !roles || roles.includes(r.role) || (r.role === 'admin' && roles.includes('owner')),
    )
    .map((r) => ({ userId: r.userId }));
}

/** Staff holding any of the given roles (active grants only). */
export async function staffWithRoles(
  tx: DbExecutor,
  roles: Array<(typeof schema.staffRoleEnum.enumValues)[number]>,
): Promise<RecipientSpec[]> {
  const rows = await tx
    .select({ userId: schema.staffRoles.userId })
    .from(schema.staffRoles)
    .where(and(inArray(schema.staffRoles.role, roles), isNull(schema.staffRoles.revokedAt)));
  return [...new Set(rows.map((r) => r.userId))].map((userId) => ({ userId }));
}
