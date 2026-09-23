import type { Metadata } from 'next';
import { auditListQuerySchema } from '@simplexd/contracts';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { auditFilterOptions, listAuditEvents } from '@/server/admin/audit/list';
import { adminContext } from '@/server/admin/context';
import { cleanSearchParams } from '../market-data/_lib/params';
import { AuditLog } from './audit-log';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireStaffPage('audit.read');
  const parsed = auditListQuerySchema.safeParse(cleanSearchParams(await searchParams));
  const query = parsed.success ? parsed.data : auditListQuerySchema.parse({});
  const ctx = adminContext(identity);
  const [page, options] = await Promise.all([listAuditEvents(ctx, query), auditFilterOptions(ctx)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Immutable record of who changed what, when and why, with before/after snapshots. Read-only." />
      <AuditLog initial={page} query={query} options={options} />
    </div>
  );
}
