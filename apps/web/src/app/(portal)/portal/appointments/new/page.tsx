import type { Metadata } from 'next';
import Link from 'next/link';
import { uuidSchema } from '@simplexd/contracts';
import { Card, CardContent, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { AvailabilityPicker } from '@/components/portal/availability-picker';

export const metadata: Metadata = { title: 'Book an appointment' };
export const dynamic = 'force-dynamic';

export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; kind?: string }>;
}) {
  const identity = await requireSignedIn('/portal/appointments/new');
  const { request, kind } = await searchParams;
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const requestId = request && uuidSchema.safeParse(request).success ? request : undefined;
  const defaultKind =
    kind === 'viewing' ||
    kind === 'site_visit' ||
    kind === 'virtual_inspection' ||
    kind === 'meeting'
      ? kind
      : 'consultation';
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/appointments" className="underline">
            Appointments
          </Link>
        }
        title="Book an appointment"
        description="Slots come from the team's live availability minus existing bookings and holds. Times are shown in your zone and the business zone, daylight-saving aware."
      />
      <Card>
        <CardContent className="pt-5">
          <AvailabilityPicker
            mode="book"
            defaultKind={defaultKind}
            defaultZone={zone}
            serviceRequestId={requestId}
          />
        </CardContent>
      </Card>
    </div>
  );
}
