import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { and, eq, inArray, not } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import { requireSignedIn } from '@/lib/auth/session';
import { isFeatureEnabled } from '@/lib/features';
import type { PartnerIdentity } from '@/lib/partner/context';
import { PartnerShell } from '@/components/partner/shell';

export const metadata: Metadata = {
  title: { default: 'Partner workspace', template: '%s · Partner · SimplexD' },
  robots: { index: false, follow: false, noarchive: true },
};
export const dynamic = 'force-dynamic';

/**
 * Partner and inspector workspace shell. Entry requires a signed-in user who
 * either has a partner profile, holds the staff inspector role, or has at
 * least one live assignment. Every page and endpoint still checks its own
 * permission; the navigation is filtered by role for clarity only.
 */
export default async function PartnerLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/partner');
  const userId = identity.session!.user.id;
  const db = getDb();
  const [profile, liveAssignments] = await withActor(
    db,
    { userId, organizationId: null, staff: false },
    async (tx) => {
      return Promise.all([
        tx
          .select({
            partnerType: schema.partnerProfiles.partnerType,
            displayName: schema.partnerProfiles.displayName,
            credentials: schema.partnerProfiles.credentials,
            verificationStatus: schema.partnerProfiles.verificationStatus,
            verifiedAt: schema.partnerProfiles.verifiedAt,
            verificationExpiresAt: schema.partnerProfiles.verificationExpiresAt,
            verificationScope: schema.partnerProfiles.verificationScope,
          })
          .from(schema.partnerProfiles)
          .where(eq(schema.partnerProfiles.userId, userId))
          .then((rows) => rows[0] ?? null),
        tx
          .select({ id: schema.assignments.id })
          .from(schema.assignments)
          .where(
            and(
              eq(schema.assignments.assigneeUserId, userId),
              not(inArray(schema.assignments.status, ['declined', 'revoked'])),
            ),
          )
          .limit(1),
      ]);
    },
  );
  const isStaffInspector = identity.actor.staffRoles.includes('inspector');
  const isPartner = identity.actor.isPartner && profile !== null;
  if (!isPartner && !isStaffInspector && liveAssignments.length === 0) {
    redirect('/portal?denied=partner');
  }
  const value: PartnerIdentity = {
    userId,
    name: identity.session!.user.name,
    email: identity.session!.user.email,
    timeZone: identity.profile?.timeZone ?? 'Africa/Lagos',
    isPartner,
    partnerType: profile?.partnerType ?? null,
    displayName: profile?.displayName ?? null,
    isStaffInspector,
    isStaff: identity.actor.staffRoles.length > 0,
    verification: profile
      ? {
          status: profile.verificationStatus,
          scope: profile.verificationScope,
          verifiedAt: profile.verifiedAt?.toISOString() ?? null,
          expiresAt: profile.verificationExpiresAt?.toISOString() ?? null,
          credentials: (profile.credentials ?? []).map((c) => ({
            title: c.title,
            issuer: c.issuer,
            verifiedAt: c.verifiedAt,
            expiresAt: c.expiresAt,
          })),
        }
      : null,
    flags: {
      tendering: isFeatureEnabled(identity, 'expansion.contractor_tendering'),
      procurement: isFeatureEnabled(identity, 'expansion.materials_procurement'),
    },
  };
  return <PartnerShell identity={value}>{children}</PartnerShell>;
}
