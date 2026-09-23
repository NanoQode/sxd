import type { Metadata } from 'next';
import Link from 'next/link';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, Button, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listSettings } from '@/server/admin/platform/settings';
import { SettingsEditor } from './settings-editor';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const identity = await requireSignedIn('/admin/settings');
  const canSettings = hasStaffPermission(identity.actor, 'platform.settings.manage');
  // Platform settings are MFA-protected for reading as well as editing.
  const needsMfa = canSettings && !identity.actor.mfaVerified;
  const items = canSettings && !needsMfa ? await listSettings(adminContext(identity)) : [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Whitelisted platform settings. Feature flags, staff access and partner verification have their own pages; provider credentials are managed under Integrations."
        actions={
          <>
            {hasStaffPermission(identity.actor, 'platform.feature_flags.manage') ? (
              <Link href="/admin/settings/feature-flags">
                <Button variant="secondary">Feature flags</Button>
              </Link>
            ) : null}
            {hasStaffPermission(identity.actor, 'access.staff_roles.manage') ? (
              <Link href="/admin/access">
                <Button variant="secondary">Access</Button>
              </Link>
            ) : null}
            {hasStaffPermission(identity.actor, 'access.partners.verify') ? (
              <Link href="/admin/access/partners">
                <Button variant="secondary">Partner verification</Button>
              </Link>
            ) : null}
            <Link href="/admin/security/mfa">
              <Button variant="ghost">Authenticator</Button>
            </Link>
          </>
        }
      />
      {needsMfa ? (
        <Alert tone="warning" title="Verify your authenticator to open platform settings">
          Platform settings are protected by multi-factor authentication.{' '}
          <Link href="/admin/security/mfa?required=1" className="underline">
            Set up or verify your authenticator
          </Link>
          , then return to this page.
        </Alert>
      ) : canSettings ? (
        <SettingsEditor items={items} canEdit={identity.actor.mfaVerified} />
      ) : (
        <Alert tone="info" title="Platform settings need platform.settings.manage">
          Use the links above for the sections you can manage.
        </Alert>
      )}
    </div>
  );
}
