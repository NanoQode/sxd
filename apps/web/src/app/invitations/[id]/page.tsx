import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ThemeToggle, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { getInvitationView } from '@/server/portal/organizations';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Invitation', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

export default async function InvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await getIdentity();
  const invitation = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await getInvitationView(id, identity) : null;
  const signedIn = Boolean(identity.session);
  const sessionEmail = identity.session?.user.email ?? null;
  const nextPath = `/invitations/${id}`;
  const emailMatches = Boolean(invitation && sessionEmail && invitation.email.toLowerCase() === sessionEmail.toLowerCase());

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sx-container flex h-16 items-center justify-between">
        <Link href="/" className="font-display text-lg font-semibold">
          SimplexD
        </Link>
        <ThemeToggle compact />
      </header>
      <main className="sx-container flex flex-1 items-start justify-center py-8">
        <Card className="w-full max-w-md">
          {!invitation ? (
            <CardContent className="pt-5">
              <Alert tone="danger" title="Invitation not found">
                This link is not a valid invitation. Ask the person who invited you to send a new one.
              </Alert>
            </CardContent>
          ) : (
            <>
              <CardHeader>
                <CardTitle className="text-xl">Join {invitation.organizationName}</CardTitle>
                <CardDescription>
                  {invitation.inviterName ? `${invitation.inviterName} invited` : 'You were invited'}{' '}
                  {signedIn ? invitation.email : maskEmail(invitation.email)} to join as{' '}
                  <Badge tone="primary">{humanize(invitation.role)}</Badge>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {invitation.status === 'expired' ? (
                  <Alert tone="warning" title="This invitation has expired">
                    It expired on {formatDateTimeLabel(invitation.expiresAt)}. Ask an owner of {invitation.organizationName} to invite you again.
                  </Alert>
                ) : invitation.status === 'canceled' ? (
                  <Alert tone="warning" title="This invitation was revoked">
                    An owner of {invitation.organizationName} withdrew it. Contact them if you still need access.
                  </Alert>
                ) : invitation.status === 'accepted' ? (
                  <Alert tone="success" title="Already accepted">
                    This invitation has been used.{' '}
                    <Link href="/portal" className="font-medium text-primary underline">
                      Open the portal
                    </Link>
                    .
                  </Alert>
                ) : invitation.status === 'rejected' ? (
                  <Alert tone="info" title="Invitation declined">
                    This invitation was declined. Ask for a new one if that was a mistake.
                  </Alert>
                ) : !signedIn ? (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-muted">
                      Sign in with the invited email address, or create an account with it, to accept. The invitation expires on{' '}
                      {formatDateTimeLabel(invitation.expiresAt)}.
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Link href={`/sign-in?next=${encodeURIComponent(nextPath)}`} className="sx-touch inline-flex flex-1 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary">
                        Sign in
                      </Link>
                      <Link href={`/sign-up?next=${encodeURIComponent(nextPath)}`} className="sx-touch inline-flex flex-1 items-center justify-center rounded-md border border-border-strong px-4 text-sm font-medium">
                        Create account
                      </Link>
                    </div>
                  </div>
                ) : !emailMatches ? (
                  <Alert tone="warning" title="Signed in with a different email">
                    This invitation was sent to {invitation.email}, but you are signed in as {sessionEmail}. Sign out and use the invited address, or ask
                    for an invitation to this account.
                  </Alert>
                ) : (
                  <AcceptInvitation invitationId={invitation.id} organizationName={invitation.organizationName} expiresAt={invitation.expiresAt} />
                )}
              </CardContent>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}
