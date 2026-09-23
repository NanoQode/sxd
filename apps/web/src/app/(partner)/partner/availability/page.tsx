import type { Metadata } from 'next';
import { asc, eq } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import { requireSignedIn } from '@/lib/auth/session';
import {
  AvailabilityView,
  type AvailabilityRow,
} from '@/components/partner/availability/availability-view';

export const metadata: Metadata = { title: 'Availability' };
export const dynamic = 'force-dynamic';

/**
 * Read-only: no API exists yet for partners to manage `staff_availability`,
 * so this page reads the rows directly and says so instead of faking a form.
 */
export default async function AvailabilityPage() {
  const identity = await requireSignedIn('/partner/availability');
  const userId = identity.session!.user.id;
  const [rows, profile] = await withActor(
    getDb(),
    { userId, organizationId: null, staff: false },
    async (tx) =>
      Promise.all([
        tx
          .select({
            id: schema.staffAvailability.id,
            weekday: schema.staffAvailability.weekday,
            startTime: schema.staffAvailability.startTime,
            endTime: schema.staffAvailability.endTime,
            timeZone: schema.staffAvailability.timeZone,
            kinds: schema.staffAvailability.kinds,
            active: schema.staffAvailability.active,
          })
          .from(schema.staffAvailability)
          .where(eq(schema.staffAvailability.staffUserId, userId))
          .orderBy(asc(schema.staffAvailability.weekday), asc(schema.staffAvailability.startTime))
          .catch(() => [] as AvailabilityRow[]),
        tx
          .select({ availabilityStatus: schema.partnerProfiles.availabilityStatus })
          .from(schema.partnerProfiles)
          .where(eq(schema.partnerProfiles.userId, userId))
          .then((r) => r[0] ?? null),
      ]),
  );
  return (
    <AvailabilityView
      rows={rows.map((r) => ({ ...r, kinds: r.kinds ?? null }))}
      profileStatus={profile?.availabilityStatus ?? null}
      isPartner={identity.actor.isPartner}
    />
  );
}
