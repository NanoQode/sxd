import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Rentals / Maintenance' };
export const dynamic = 'force-dynamic';

export default async function RentalsPage() {
  await requireSignedIn('/admin/rentals');
  return <PlannedSection sectionKey="rentals" />;
}
