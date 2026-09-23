import { Bell } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader } from '@simplexd/ui';
import { LoadError } from '@/components/tenant/load-error';
import { NoticeList } from '@/components/tenant/notice-list';
import { requireSignedIn } from '@/lib/auth/session';
import { leaseTitle, unreadCount } from '@/lib/tenant/model';
import { loadMyLeases, loadNotices, zoneOf } from '@/lib/tenant/server/data';

export const metadata: Metadata = { title: 'Notices' };
export const dynamic = 'force-dynamic';

/**
 * Approved notices addressed to the caller by their landlord or SimplexD.
 * They stay readable after a tenancy ends: they were sent to this person.
 */
export default async function TenantNoticesPage() {
  const identity = await requireSignedIn('/tenant/notices');
  const zone = zoneOf(identity);
  const [leases, notices] = await Promise.all([loadMyLeases(identity), loadNotices(identity)]);
  const leaseTitles = leases.ok
    ? Object.fromEntries(leases.data.map((l) => [l.lease.id, leaseTitle(l)]))
    : {};
  const unread = notices.ok ? unreadCount(notices.data) : 0;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenant" className="underline">
            Tenant home
          </Link>
        }
        title="Notices"
        description={
          notices.ok && notices.data.length > 0
            ? `Notices from your landlord or SimplexD about your lease. ${unread === 0 ? 'All read.' : `${unread} new.`}`
            : 'Notices from your landlord or SimplexD about your lease.'
        }
      />
      {!notices.ok ? (
        <LoadError title="Your notices could not be loaded" error={notices.error} />
      ) : notices.data.length === 0 ? (
        <EmptyState
          icon={<Bell aria-hidden="true" className="h-8 w-8" />}
          title="No notices yet"
          description="When your landlord or SimplexD posts a notice about access, works, rent reviews or the building, it appears here."
        />
      ) : (
        <NoticeList notices={notices.data} zone={zone} leaseTitles={leaseTitles} />
      )}
    </div>
  );
}
