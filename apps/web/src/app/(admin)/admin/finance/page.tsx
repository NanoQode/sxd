import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Finance' };
export const dynamic = 'force-dynamic';

export default async function FinancePage() {
  await requireSignedIn('/admin/finance');
  return <PlannedSection sectionKey="finance" />;
}
