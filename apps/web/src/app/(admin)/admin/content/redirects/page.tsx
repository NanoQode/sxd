import type { Metadata } from 'next';
import Link from 'next/link';
import { authorizeStaff } from '@simplexd/domain/authz';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listRedirects } from '@/server/content/redirects';
import { RedirectsManager } from './redirects-manager';

export const metadata: Metadata = { title: 'Redirects' };
export const dynamic = 'force-dynamic';

export default async function RedirectsPage() {
  const identity = await requireStaffPage('content.edit');
  const redirects = await listRedirects(identity);
  const canManage = authorizeStaff(identity.actor, 'content.publish').allowed;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/content" className="underline">
            Content
          </Link>
        }
        title="Redirects"
        description="Preserve approved URLs from the current site with tested 301 redirects. Resolution is cached for 60 seconds; toggling a redirect invalidates the cache."
      />
      <RedirectsManager initial={redirects} canManage={canManage} />
    </div>
  );
}
