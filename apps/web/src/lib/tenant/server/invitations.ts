import 'server-only';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { INVITATION_TOKEN_PATTERN, maskEmail } from '@/lib/tenant/model';
import { elevated } from '@/server/rentals/shared';

/**
 * Read-only preview of a lease invitation for the accept page. The tenant
 * API has no preview endpoint, and the invitee cannot see the party row
 * through row-level security until it is active, so this reads it elevated
 * by the hash of the token (the same hashing the accept service uses) and
 * returns only what identifies the invitation: the property, unit, role,
 * dates and expiry, and whether the signed-in e-mail is the invited one.
 * It never writes; accepting always goes through
 * `POST /api/v1/tenant/invitations/accept`.
 *
 * Tokens are cleared when an invitation is accepted, revoked or marked
 * expired, so those states all read as `unavailable`: the page says so
 * honestly instead of guessing which one it was.
 */

export type TenantInvitationPreview =
  | { state: 'invalid' }
  | { state: 'unavailable' }
  | {
      state: 'invited' | 'expired';
      role: string;
      propertyName: string;
      unitLabel: string | null;
      leaseKind: string;
      startDate: string;
      endDate: string | null;
      expiresAt: string | null;
      /** Full address only when it is the signed-in user's own; masked otherwise. */
      invitedEmail: string | null;
      emailMatches: boolean;
    };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function previewTenantInvitation(
  identity: RequestIdentity,
  token: string | undefined,
  now: Date = new Date(),
): Promise<TenantInvitationPreview> {
  if (!token || !INVITATION_TOKEN_PATTERN.test(token)) return { state: 'invalid' };
  const sessionEmail = identity.session?.user.email?.toLowerCase() ?? null;
  const hash = hashToken(token);
  return withActor(getDb(), identity.ctx, async (tx) =>
    elevated(tx, identity.ctx, async (): Promise<TenantInvitationPreview> => {
      const [party] = await tx
        .select({
          leaseId: schema.leaseParties.leaseId,
          role: schema.leaseParties.role,
          email: schema.leaseParties.email,
          accessStatus: schema.leaseParties.accessStatus,
          expiresAt: schema.leaseParties.invitationExpiresAt,
        })
        .from(schema.leaseParties)
        .where(eq(schema.leaseParties.invitationTokenHash, hash))
        .limit(1);
      if (!party || party.accessStatus !== 'invited') return { state: 'unavailable' };
      const [lease] = await tx
        .select({
          kind: schema.leases.kind,
          startDate: schema.leases.startDate,
          endDate: schema.leases.endDate,
          propertyId: schema.leases.propertyId,
          unitId: schema.leases.unitId,
        })
        .from(schema.leases)
        .where(eq(schema.leases.id, party.leaseId));
      if (!lease) return { state: 'unavailable' };
      const [property] = await tx
        .select({ name: schema.properties.name })
        .from(schema.properties)
        .where(eq(schema.properties.id, lease.propertyId));
      const [unit] = lease.unitId
        ? await tx
            .select({ label: schema.units.label })
            .from(schema.units)
            .where(eq(schema.units.id, lease.unitId))
        : [];
      // The accept service only compares addresses when the invitation names one.
      const emailMatches =
        !party.email || Boolean(sessionEmail && party.email.toLowerCase() === sessionEmail);
      const expired = Boolean(party.expiresAt && party.expiresAt.getTime() < now.getTime());
      return {
        state: expired ? 'expired' : 'invited',
        role: party.role,
        propertyName: property?.name ?? 'Property',
        unitLabel: unit?.label ?? null,
        leaseKind: lease.kind,
        startDate: lease.startDate,
        endDate: lease.endDate,
        expiresAt: party.expiresAt ? party.expiresAt.toISOString() : null,
        invitedEmail: party.email ? (emailMatches ? party.email : maskEmail(party.email)) : null,
        emailMatches,
      };
    }),
  );
}
