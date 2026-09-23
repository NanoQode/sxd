import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  StatusBadge,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listIntegrations } from '@/server/integrations/service';
import { fmtDate } from '../_components/bits';
import { statusLabel } from './labels';
import { RewrapButton } from './rewrap-button';

export const metadata: Metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const identity = await requireStaffPage('integrations.read');
  const overview = await listIntegrations(adminContext(identity));
  const needsMfa =
    (overview.permissions.manage || overview.permissions.rotate) &&
    !overview.permissions.mfaVerified;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Payment, SMS, email, calendar, storage, scanner and map providers. Saving settings, testing them and activating a version are three separate steps; a saved form is never shown as connected."
        eyebrow={`Runtime reads the ${overview.defaultEnvironment} environment (APP_ENV=${overview.appEnv})`}
        actions={
          overview.permissions.rotate ? (
            <RewrapButton
              pending={overview.secretsNeedingRewrap}
              masterKeyId={overview.masterKeyId}
              disabled={!overview.permissions.mfaVerified}
            />
          ) : null
        }
      />
      {needsMfa ? (
        <Alert tone="warning" title="Verified authenticator required">
          Saving, activating, disabling or rotating integration credentials needs a verified
          authenticator on your account. You can still read status and run tests.{' '}
          <Link href="/admin/security/mfa" className="underline">
            Set up MFA
          </Link>
        </Alert>
      ) : null}
      {overview.secretsNeedingRewrap > 0 ? (
        <Alert
          tone="info"
          title={`${overview.secretsNeedingRewrap} secret${overview.secretsNeedingRewrap === 1 ? '' : 's'} still wrapped by a previous master key`}
        >
          Run “Re-wrap secrets” after rotating SECRETS_MASTER_KEY so the previous key can be
          retired.
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {overview.items.map((item) => (
          <Card key={item.provider} className="flex flex-col">
            <CardHeader>
              <CardTitle>
                <Link
                  href={`/admin/integrations/${item.provider}`}
                  className="rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus hover:underline"
                >
                  {item.name}
                </Link>
              </CardTitle>
              <p className="text-sm text-fg-muted">{item.summary}</p>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              {item.environments.map((env) => {
                const shown = env.active ?? env.latest;
                return (
                  <div
                    key={env.environment}
                    className="rounded-md border border-border p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge tone={env.environment === 'live' ? 'gold' : 'neutral'}>
                          {env.environment}
                        </Badge>
                        {env.environment === overview.defaultEnvironment ? (
                          <span className="text-xs text-fg-muted">runtime</span>
                        ) : null}
                      </div>
                      <StatusBadge status={env.status} label={statusLabel(env.status, shown)} />
                    </div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-fg-muted">
                      <dt>Adapter</dt>
                      <dd className="text-fg">
                        {shown
                          ? `${shown.adapter}${shown.developmentAdapter ? ' (development)' : ''}`
                          : '—'}
                      </dd>
                      <dt>Active version</dt>
                      <dd className="text-fg">
                        {env.active
                          ? `v${env.active.version}`
                          : env.versionCount > 0
                            ? `none (${env.versionCount} saved)`
                            : 'none'}
                      </dd>
                      <dt>Last check</dt>
                      <dd className="text-fg">
                        {shown?.lastCheckAt
                          ? `${shown.lastCheckOk ? 'passed' : 'failed'} · ${fmtDate(shown.lastCheckAt)}`
                          : 'never'}
                      </dd>
                      <dt>Credential rotated</dt>
                      <dd className="text-fg">{fmtDate(shown?.credentialRotatedAt)}</dd>
                    </dl>
                    {shown?.remedialAction ? (
                      <p className="mt-2 text-xs text-fg-muted">{shown.remedialAction}</p>
                    ) : null}
                  </div>
                );
              })}
              <div className="mt-auto pt-1">
                <Link href={`/admin/integrations/${item.provider}`}>
                  <Button variant="secondary" size="sm">
                    Configure
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
