import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { NotificationsFeed } from '@/components/portal/notifications-feed';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const identity = await requireSignedIn('/portal/notifications');
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={
          <>
            Everything that changed on your account. Email and SMS follow the preferences in{' '}
            <Link href="/portal/settings" className="underline">
              settings
            </Link>
            .
          </>
        }
      />
      <NotificationsFeed zone={zone} />
    </div>
  );
}
