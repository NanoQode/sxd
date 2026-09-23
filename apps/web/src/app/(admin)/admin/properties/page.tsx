import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Properties' };
export const dynamic = 'force-dynamic';

export default async function PropertiesPage() {
  await requireSignedIn('/admin/properties');
  return <PlannedSection sectionKey="properties" />;
}
