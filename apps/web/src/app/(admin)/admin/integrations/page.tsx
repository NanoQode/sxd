import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  await requireSignedIn('/admin/integrations');
  return <PlannedSection sectionKey="integrations" />;
}
