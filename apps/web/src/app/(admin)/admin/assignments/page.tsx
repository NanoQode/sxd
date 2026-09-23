import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Assignments' };
export const dynamic = 'force-dynamic';

export default async function AssignmentsPage() {
  await requireSignedIn('/admin/assignments');
  return <PlannedSection sectionKey="assignments" />;
}
