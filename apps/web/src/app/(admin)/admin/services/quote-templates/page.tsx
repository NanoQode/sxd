import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { LoadError } from '@/components/admin/load-error';
import { adminContext } from '@/server/admin/context';
import { listQuoteTemplates } from '@/server/admin/configuration/quote-templates';
import { listConfigServices } from '@/server/admin/configuration/shared';
import { QuoteTemplatesEditor } from './quote-templates-editor';

export const metadata: Metadata = { title: 'Quote templates' };
export const dynamic = 'force-dynamic';

export default async function QuoteTemplatesPage() {
  const identity = await requireSignedIn('/admin/services/quote-templates');
  const ctx = adminContext(identity);
  const canManage = hasStaffPermission(identity.actor, 'pricing.manage');
  const loaded = await attempt(() => listQuoteTemplates(ctx));
  const services = await listConfigServices(ctx);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Quotation templates"
        description="Reusable lines, scope and exclusions that staff start a quote from on a service request. The issued quote is its own versioned record: editing or retiring a template never changes a quote already drafted."
      />
      {!canManage ? (
        <Alert tone="info" title="Read-only">
          Creating and editing templates needs pricing.manage.
        </Alert>
      ) : null}
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="Quote templates" />
      ) : (
        <QuoteTemplatesEditor items={loaded.value} services={services} canManage={canManage} />
      )}
    </div>
  );
}
