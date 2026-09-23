import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { LoadError } from '@/components/admin/load-error';
import { adminContext } from '@/server/admin/context';
import { listDocumentRequirements } from '@/server/admin/configuration/document-requirements';
import { listConfigServices } from '@/server/admin/configuration/shared';
import { DocumentRequirementsEditor } from './document-requirements-editor';

export const metadata: Metadata = { title: 'Document requirements' };
export const dynamic = 'force-dynamic';

export default async function DocumentRequirementsPage() {
  const identity = await requireSignedIn('/admin/services/document-requirements');
  const ctx = adminContext(identity);
  const canManage = hasStaffPermission(identity.actor, 'pricing.manage');
  const loaded = await attempt(() => listDocumentRequirements(ctx));
  const services = await listConfigServices(ctx);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Document requirements"
        description="What each service asks the customer for and from which stage. Customers see the list on their request; the public service page shows the non-sensitive items as “What you’ll need”."
      />
      <Alert tone="info" title="Sensitive documents">
        Mark identity papers, proof of funds and similar as sensitive. They are collected only when
        the transaction requires them, never listed publicly, and are opened only by the people
        working on the request (files.sensitive.read).
      </Alert>
      {!canManage ? (
        <Alert tone="info" title="Read-only">
          Adding and editing requirements needs pricing.manage.
        </Alert>
      ) : null}
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="Document requirements" />
      ) : (
        <DocumentRequirementsEditor
          items={loaded.value}
          services={services}
          canManage={canManage}
        />
      )}
    </div>
  );
}
