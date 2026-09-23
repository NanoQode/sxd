import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

export default async function AppointmentsPage() {
  await requireSignedIn('/admin/appointments');
  return <PlannedSection sectionKey="appointments" />;
}
