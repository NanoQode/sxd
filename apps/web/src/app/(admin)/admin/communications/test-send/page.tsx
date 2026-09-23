import type { Metadata } from 'next';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn, requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import {
  communicationsAccess,
  listTemplateCatalog,
  providerOverview,
} from '@/server/admin/communications/service';
import { TestSendForm, type ProviderHint, type TemplateOption } from './test-send-form';

export const metadata: Metadata = { title: 'Test send' };
export const dynamic = 'force-dynamic';

/**
 * Explicit, permission-controlled test sends to a staff-entered address. The
 * page shows which adapter will handle the send before anything goes out and
 * the real provider answer afterwards, separately from delivery status.
 */
export default async function TestSendPage() {
  const identity = await requireSignedIn('/admin/communications/test-send');
  const ctx = adminContext(identity);
  const access = communicationsAccess(ctx);
  if (!access.testSend) await requireStaffPage('notifications.test_send');
  const [providers, families] = await Promise.all([
    access.providers ? providerOverview(ctx).catch(() => null) : Promise.resolve(null),
    access.templates ? listTemplateCatalog(ctx).catch(() => null) : Promise.resolve(null),
  ]);
  const hints: ProviderHint[] = (providers ?? []).map((p) => ({
    channel: p.channel,
    adapter: p.adapter,
    environment: p.environment,
    configured: p.configured,
    devFallback: p.devFallback,
    status: p.status,
  }));
  const templates: TemplateOption[] = (families ?? [])
    .filter((f) => f.channel !== 'in_app' && f.locale === 'en')
    .map((f) => ({
      key: f.key,
      channel: f.channel as 'email' | 'sms',
      activeVersion: f.activeVersion,
      latestVersion: f.latestVersion,
    }));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Test send"
        description="Send one email or SMS to an address you type. The recipient is shown before sending; templates render with sample data, never a customer’s. The result shows the provider’s own answer, and delivery status separately."
      />
      {!access.providers ? (
        <Alert tone="info" title="Adapter is shown after sending">
          Provider status needs integrations.read, so the adapter that handled the send is
          reported in the result instead of beforehand.
        </Alert>
      ) : null}
      <TestSendForm
        providers={hints}
        templates={templates}
        canOpenLog={access.templates}
        templatesKnown={families !== null}
      />
    </div>
  );
}
