import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  await requireSignedIn('/admin/customers');
  return <PlannedSection sectionKey="customers" />;
}
