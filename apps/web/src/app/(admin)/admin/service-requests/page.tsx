import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Service Requests' };
export const dynamic = 'force-dynamic';

export default async function ServiceRequestsPage() {
  await requireSignedIn('/admin/service-requests');
  return <PlannedSection sectionKey="service-requests" />;
}
