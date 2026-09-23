import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { getStaffAvailability } from '@/server/appointments/staff-availability';
import { listStaffAssignees } from '@/server/leads/admin';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Section } from '@/components/admin/section';
import { AvailabilityEditor } from '../_components/availability-editor';

export const metadata: Metadata = { title: 'Staff availability' };
export const dynamic = 'force-dynamic';

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireStaffPage('appointments.manage_all');
  const raw = await searchParams;
  const staff = await listStaffAssignees(identity);
  const me = identity.session!.user.id;
  const staffUserId = raw.staff && staff.some((s) => s.userId === raw.staff) ? raw.staff : me;
  const person = staff.find((s) => s.userId === staffUserId);
  const loaded = await attempt(() => getStaffAvailability(identity, staffUserId));
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/appointments" className="underline">
            Appointments
          </Link>
        }
        title="Staff availability"
        description="Weekly working windows generate the bookable slots; time off blocks them. Booking durations, buffers and notice are platform settings."
      />
      <FilterBar submitLabel="Open">
        <FilterSelect
          name="staff"
          label="Staff member"
          value={staffUserId}
          allLabel="Me"
          options={staff.map((s) => ({ value: s.userId, label: s.name }))}
        />
      </FilterBar>
      <Section title={person?.name ?? 'Availability'}>
        {loaded.ok ? (
          <AvailabilityEditor
            key={staffUserId}
            staffUserId={staffUserId}
            staffName={person?.name ?? 'this person'}
            initial={loaded.value}
          />
        ) : (
          <LoadError code={loaded.code} message={loaded.message} what="Availability" />
        )}
      </Section>
    </div>
  );
}
