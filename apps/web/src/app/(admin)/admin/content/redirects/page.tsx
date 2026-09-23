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
        description="Preserve approved URLs from the current site with tested redirects. The proxy serves them with the configured status (301, 302 or 308) from an in-memory table refreshed every 30 seconds; creating or toggling a redirect invalidates the server cache, so changes are live within about a minute."
      />
      <RedirectsManager initial={redirects} canManage={canManage} />
    </div>
  );
}
