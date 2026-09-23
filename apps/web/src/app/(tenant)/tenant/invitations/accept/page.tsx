import { MailCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { AcceptTenantInvitation, SwitchAccount } from '@/components/tenant/accept-invitation';
import { LoadError } from '@/components/tenant/load-error';
import { requireSignedIn } from '@/lib/auth/session';
import { INVITATION_FAILURE_COPY, LEASE_KIND_LABELS, formatDay } from '@/lib/tenant/model';
import { loadMyLeases, zoneOf } from '@/lib/tenant/server/data';
import { previewTenantInvitation } from '@/lib/tenant/server/invitations';
import { safeLoad } from '@/lib/tenant/server/load';

export const metadata: Metadata = { title: 'Lease invitation' };
export const dynamic = 'force-dynamic';

/**
 * Where the `tenant.invited` e-mail link lands. Anonymous visitors are sent
 * to sign-in (or sign-up) first with this page as the destination; the page
 * then shows what the invitation is for, whether the signed-in address is
 * the invited one, and accepts through the tenant API.
 */
export default async function AcceptTenantInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const self = `/tenant/invitations/accept${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const identity = await requireSignedIn(self);
  const zone = zoneOf(identity);
  const email = identity.session!.user.email;
  const [preview, leases] = await Promise.all([
    safeLoad('this invitation', () => previewTenantInvitation(identity, token)),
    loadMyLeases(identity),
  ]);
  const hasTenancy = leases.ok && leases.data.length > 0;
  const header = (
    <PageHeader
      title="Lease invitation"
      description={`You are signed in as ${email}. Accepting links a lease to this account so you can see its balances, receipts, notices and maintenance.`}
    />
  );

  if (!preview.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError title="The invitation could not be checked" error={preview.error} />
      </div>
    );
  }
  const p = preview.data;

  if (p.state === 'invalid') {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          tone="warning"
          title="This is not a valid invitation link"
          description="The link is incomplete or was changed. Open the invitation email again and use its button, or copy the whole link into your browser."
        />
      </div>
    );
  }

  if (p.state === 'unavailable') {
    const copy = INVITATION_FAILURE_COPY.used_or_revoked;
    return (
      <div className="space-y-6">
        {header}
        <Alert tone="warning" title={copy.title}>
          {copy.body}
        </Alert>
        {hasTenancy ? (
          <Link
            href="/tenant"
            className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary"
          >
            Open your tenant home
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
            <MailCheck aria-hidden="true" className="h-5 w-5 text-primary" />
            {p.propertyName}
            {p.unitLabel ? ` · ${p.unitLabel}` : ''}
          </CardTitle>
          <CardDescription>
            You were invited as <Badge tone="primary">{humanize(p.role)}</Badge> on this lease.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-fg-muted">Lease</dt>
              <dd>{LEASE_KIND_LABELS[p.leaseKind] ?? humanize(p.leaseKind)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Term</dt>
              <dd>
                {formatDay(p.startDate)} – {p.endDate ? formatDay(p.endDate) : 'open-ended'}
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">Invited email</dt>
              <dd className="break-all">{p.invitedEmail ?? 'Not specified'}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">{p.state === 'expired' ? 'Expired' : 'Expires'}</dt>
              <dd>{p.expiresAt ? formatDateTimeLabel(p.expiresAt, zone) : 'No expiry set'}</dd>
            </div>
          </dl>

          {p.state === 'expired' ? (
            <Alert tone="warning" title={INVITATION_FAILURE_COPY.expired.title}>
              {INVITATION_FAILURE_COPY.expired.body}
            </Alert>
          ) : !p.emailMatches ? (
            <div className="space-y-3">
              <Alert tone="warning" title={INVITATION_FAILURE_COPY.wrong_email.title}>
                This invitation was sent to {p.invitedEmail}, but you are signed in as {email}. Sign
                out and sign in (or create an account) with the invited address.
              </Alert>
              <SwitchAccount />
            </div>
          ) : (
            <AcceptTenantInvitation token={token!} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
