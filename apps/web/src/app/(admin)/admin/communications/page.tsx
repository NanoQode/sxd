import type { Metadata } from 'next';
import Link from 'next/link';
import type { ProviderStatusDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  StatusBadge,
  buttonVariants,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import {
  communicationsAccess,
  listTemplateCatalog,
  providerOverview,
} from '@/server/admin/communications/service';
import { DefinitionList, fmtDate, StatTile } from '../_components/bits';
import { DELIVERY_STATUS_LABELS } from './_lib/labels';

export const metadata: Metadata = { title: 'Communications' };
export const dynamic = 'force-dynamic';

const PROVIDER_NAMES: Record<string, string> = { smtp: 'Email (SMTP)', termii: 'SMS (Termii)' };

function AdapterLine({ p }: { p: ProviderStatusDto }) {
  if (p.devFallback) {
    return (
      <Badge tone="warning">Development adapter — no real message is sent from this environment</Badge>
    );
  }
  if (!p.configured) {
    return (
      <Badge tone="danger">
        Not configured — sends fail with provider_not_configured until a configuration is active
      </Badge>
    );
  }
  return <Badge tone="primary">{p.adapter}</Badge>;
}

function ProviderCard({ p }: { p: ProviderStatusDto }) {
  const counts = Object.entries(p.last24h).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{PROVIDER_NAMES[p.provider] ?? p.provider}</CardTitle>
          <StatusBadge status={p.status} />
        </div>
        <CardDescription>Environment: {p.environment}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <AdapterLine p={p} />
        <DefinitionList
          items={[
            {
              term: 'Last connection test',
              value: p.lastCheckAt
                ? `${p.lastCheckOk ? 'passed' : 'failed'} · ${fmtDate(p.lastCheckAt)}`
                : 'never',
            },
            { term: 'Last success', value: fmtDate(p.lastSuccessAt) },
            { term: 'Credential rotated', value: fmtDate(p.credentialRotatedAt) },
            {
              term: 'Last 24 hours',
              value:
                counts.length === 0
                  ? 'no attempts'
                  : counts.map(([s, n]) => `${n} ${DELIVERY_STATUS_LABELS[s] ?? s}`).join(' · '),
            },
          ]}
        />
        {p.lastCheckMessage ? <p className="text-xs text-fg-muted">{p.lastCheckMessage}</p> : null}
        <Link
          href={`/admin/integrations/${p.provider}`}
          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
        >
          Configure, test or rotate secrets
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * Communications overview: provider state for the current environment
 * (development adapters labelled), real 24-hour delivery counts and links to
 * templates, test sends, the delivery log and suppressions.
 */
export default async function CommunicationsOverviewPage() {
  const identity = await requireSignedIn('/admin/communications');
  const ctx = adminContext(identity);
  const access = communicationsAccess(ctx);
  const [providers, families] = await Promise.all([
    access.providers ? providerOverview(ctx) : Promise.resolve(null),
    access.templates ? listTemplateCatalog(ctx) : Promise.resolve(null),
  ]);
  const failed24h = providers
    ? providers.reduce(
        (sum, p) =>
          sum + (p.last24h['failed'] ?? 0) + (p.last24h['rejected'] ?? 0) + (p.last24h['bounced'] ?? 0),
        0,
      )
    : null;
  const withoutActive = families?.filter((f) => f.activeVersion === null).length ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Communications"
        description="Email, SMS and in-app notification templates, explicit test sends, the delivery log and suppressions. Provider credentials live under Integrations."
        actions={
          access.testSend ? (
            <Link href="/admin/communications/test-send" className={buttonVariants()}>
              Send a test
            </Link>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {families ? (
          <StatTile
            label="Template families"
            value={families.length}
            href="/admin/communications/templates"
            hint="Key × channel × locale"
          />
        ) : null}
        {withoutActive !== null ? (
          <StatTile
            label="Without an active version"
            value={withoutActive}
            href="/admin/communications/templates"
            tone={withoutActive > 0 ? 'warning' : 'neutral'}
            hint="Nothing sends for these in production"
          />
        ) : null}
        {failed24h !== null ? (
          <StatTile
            label="Failed, rejected or bounced (24 h)"
            value={failed24h}
            href={access.templates ? '/admin/communications/deliveries?status=failed' : undefined}
            tone={failed24h > 0 ? 'danger' : 'neutral'}
            hint="Email and SMS"
          />
        ) : null}
      </div>

      {providers ? (
        <section aria-labelledby="providers-heading" className="space-y-3">
          <h2 id="providers-heading" className="text-lg font-semibold">
            Providers
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {providers.map((p) => (
              <ProviderCard key={p.provider} p={p} />
            ))}
          </div>
          <p className="text-sm text-fg-muted">
            SMS “accepted” means Termii took the message; only a delivery receipt marks it
            delivered. Email “accepted by relay” means the SMTP server took it; SMTP never confirms
            delivery, and a bounce import is the only later signal.
          </p>
        </section>
      ) : (
        <Alert tone="info" title="Provider status needs integrations.read">
          You can still send tests; the result shows which adapter handled each send.
        </Alert>
      )}

      {!access.templates ? (
        <Alert tone="info" title="Templates, the delivery log and suppressions">
          These need notifications.templates.manage. Your role can send explicit tests.
        </Alert>
      ) : null}
    </div>
  );
}
