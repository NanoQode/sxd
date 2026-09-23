import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  await requireSignedIn('/admin/messages');
  return <PlannedSection sectionKey="messages" />;
}
