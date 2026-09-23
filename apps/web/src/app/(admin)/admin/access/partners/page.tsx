import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listPartnerQueue } from '@/server/admin/access/partners';
import { adminContext } from '@/server/admin/context';
import { PartnersQueue } from './partners-queue';

export const metadata: Metadata = { title: 'Partner verification' };
export const dynamic = 'force-dynamic';

export default async function PartnersQueuePage() {
  const identity = await requireStaffPage('access.partners.verify');
  const items = await listPartnerQueue(adminContext(identity));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Partner verification"
        description="Record exactly what was checked; the partner badge later states that scope and expiry, never a generic 'verified'."
      />
      <PartnersQueue items={items} />
    </div>
  );
}
