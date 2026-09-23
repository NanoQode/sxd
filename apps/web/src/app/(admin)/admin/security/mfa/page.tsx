import type { Metadata } from 'next';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { MfaManager } from './mfa-manager';

export const metadata: Metadata = { title: 'Authenticator (MFA)' };
export const dynamic = 'force-dynamic';

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string; welcome?: string }>;
}) {
  const identity = await requireSignedIn('/admin/security/mfa');
  const params = await searchParams;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Authenticator (MFA)"
        description="Staff with finance, access, data-publication or integration permissions must verify a time-based one-time password app before sensitive actions."
      />
      {params.welcome ? (
        <Alert tone="success" title="Administrator account created">
          Finish by enrolling an authenticator app so publication and configuration actions are available.
        </Alert>
      ) : null}
      {params.required && !identity.actor.mfaVerified ? (
        <Alert tone="warning" title="A verified authenticator is required for that action">
          Enrol below, then return to what you were doing.
        </Alert>
      ) : null}
      <MfaManager enabled={identity.actor.mfaVerified} email={identity.session!.user.email} />
    </div>
  );
}
