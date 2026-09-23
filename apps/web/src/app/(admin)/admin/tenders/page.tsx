import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Tenders' };
export const dynamic = 'force-dynamic';

export default async function TendersPage() {
  await requireSignedIn('/admin/tenders');
  return <PlannedSection sectionKey="tenders" />;
}
