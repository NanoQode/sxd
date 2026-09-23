import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import { requireSignedIn } from '@/lib/auth/session';
import { AvailabilityView } from '@/components/partner/availability/availability-view';

export const metadata: Metadata = { title: 'Availability' };
export const dynamic = 'force-dynamic';

/**
 * Weekly hours and time off are read and written through
 * `/api/v1/appointments/staff/{userId}` by the client editor; only the
 * partner-profile status (set by staff) is read here.
 */
export default async function AvailabilityPage() {
  const identity = await requireSignedIn('/partner/availability');
  const userId = identity.session!.user.id;
  const profile = await withActor(
    getDb(),
    { userId, organizationId: null, staff: false },
    async (tx) =>
      tx
        .select({ availabilityStatus: schema.partnerProfiles.availabilityStatus })
        .from(schema.partnerProfiles)
        .where(eq(schema.partnerProfiles.userId, userId))
        .then((r) => r[0] ?? null),
  );
  return (
    <AvailabilityView
      profileStatus={profile?.availabilityStatus ?? null}
      isPartner={identity.actor.isPartner}
    />
  );
}
