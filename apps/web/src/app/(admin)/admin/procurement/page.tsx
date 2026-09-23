import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Procurement' };
export const dynamic = 'force-dynamic';

export default async function ProcurementPage() {
  await requireSignedIn('/admin/procurement');
  return <PlannedSection sectionKey="procurement" />;
}
