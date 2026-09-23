import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Partners' };
export const dynamic = 'force-dynamic';

export default async function PartnersPage() {
  await requireSignedIn('/admin/partners');
  return <PlannedSection sectionKey="partners" />;
}
