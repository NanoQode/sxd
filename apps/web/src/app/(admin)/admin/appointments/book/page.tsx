import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listStaffAssignees } from '@/server/leads/admin';
import { Section } from '@/components/admin/section';
import { BookingForm } from '../_components/booking-form';

export const metadata: Metadata = { title: 'Book an appointment' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BookAppointmentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireStaffPage('appointments.manage_all');
  const raw = await searchParams;
  const staff = await listStaffAssignees(identity);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/appointments" className="underline">
            Appointments
          </Link>
        }
        title="Book an appointment"
        description="Uses the live availability and short holds, so two people cannot take the same slot."
      />
      <Section title="Slot and details">
        <BookingForm
          staff={staff.map((s) => ({ userId: s.userId, name: s.name }))}
          serviceRequestId={raw.serviceRequestId && UUID.test(raw.serviceRequestId) ? raw.serviceRequestId : undefined}
          leadId={raw.leadId && UUID.test(raw.leadId) ? raw.leadId : undefined}
          customerHint={raw.customer?.slice(0, 200)}
        />
      </Section>
    </div>
  );
}
