import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@simplexd/contracts';
import { Alert, Button, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { getIntegration, listIntegrationLogs } from '@/server/integrations/service';
import { ProviderPanel } from './provider-panel';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ provider: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { provider } = await params;
  return { title: `Integrations · ${provider}` };
}

export default async function IntegrationProviderPage({ params }: Params) {
  const { provider } = await params;
  if (!(INTEGRATION_PROVIDERS as readonly string[]).includes(provider)) notFound();
  const identity = await requireStaffPage('integrations.read');
  const ctx = adminContext(identity);
  const [detail, logs] = await Promise.all([
    getIntegration(ctx, provider as IntegrationProvider),
    listIntegrationLogs(ctx, provider as IntegrationProvider, { limit: 50 }),
  ]);
  const actor = identity.actor;
  const permissions = {
    manage: hasStaffPermission(actor, 'integrations.manage'),
    test: hasStaffPermission(actor, 'integrations.test'),
    rotate: hasStaffPermission(actor, 'integrations.secrets.rotate'),
    paymentCredentials: hasStaffPermission(actor, 'integrations.payment_credentials.manage'),
    mfaVerified: actor.mfaVerified,
  };
  const needsMfa = (permissions.manage || permissions.rotate) && !permissions.mfaVerified;
  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.descriptor.name}
        eyebrow="Integrations"
        description={detail.descriptor.summary}
        actions={
          <>
            <Link href="/admin/integrations"><Button variant="ghost">All integrations</Button></Link>
            {detail.descriptor.links.map((l) =>
              l.external ? (
                <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
                  <Button variant="secondary">{l.label} ↗</Button>
                </a>
              ) : (
                <Link key={l.href} href={l.href}><Button variant="secondary">{l.label}</Button></Link>
              ),
            )}
          </>
        }
      />
      {needsMfa ? (
        <Alert tone="warning" title="Verified authenticator required">
          Saving, activating, disabling or rotating credentials for this provider needs a verified authenticator.{' '}
          <Link href="/admin/security/mfa" className="underline">Set up MFA</Link>. Reading status and running the connection test still work.
        </Alert>
      ) : null}
      <ProviderPanel detail={detail} logs={logs} permissions={permissions} />
    </div>
  );
}
