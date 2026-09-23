import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { LoadError } from '@/components/admin/load-error';
import { adminContext } from '@/server/admin/context';
import { listReportTemplates } from '@/server/admin/configuration/report-templates';
import { ReportTemplatesEditor } from './report-templates-editor';

export const metadata: Metadata = { title: 'Report templates' };
export const dynamic = 'force-dynamic';

export default async function ReportTemplatesPage() {
  const identity = await requireSignedIn('/admin/services/report-templates');
  const canManage = hasStaffPermission(identity.actor, 'reports.review');
  const loaded = await attempt(() => listReportTemplates(adminContext(identity)));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Report templates"
        description="Ordered section outlines and the standard scope/limitations wording per report kind. One template per kind is active; a new report starts from it and keeps its own copy, so editing a template never rewrites an issued report."
      />
      {!canManage ? (
        <Alert tone="info" title="Read-only">
          Creating, editing and activating templates needs reports.review.
        </Alert>
      ) : null}
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="Report templates" />
      ) : (
        <ReportTemplatesEditor items={loaded.value} canManage={canManage} />
      )}
    </div>
  );
}
