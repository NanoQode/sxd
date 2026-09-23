import type { Metadata } from 'next';
import { NotificationsFeed } from '@/components/partner/notifications/notifications-feed';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return <NotificationsFeed />;
}
