import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  await requireSignedIn('/admin/reports');
  return <PlannedSection sectionKey="reports" />;
}
