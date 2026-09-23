import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities } from '@/lib/portal/server/permissions';
import { TasksList } from '@/components/portal/tasks-list';
import { listMyTasks } from '@/server/tasks/service';

export const metadata: Metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const identity = await requireSignedIn('/portal/tasks');
  const { cursor } = await searchParams;
  const page = await listMyTasks(identity, { limit: 50, cursor });
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks awaiting you"
        description="Open tasks the team raised for your organisation or assigned to you personally. Decisions (quotes, change orders, milestones) live on their own pages."
      />
      <TasksList tasks={page.items} zone={zone} canComplete={Boolean(caps.organizationId)} />
      {page.nextCursor ? (
        <Link
          href={`/portal/tasks?cursor=${encodeURIComponent(page.nextCursor)}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}
