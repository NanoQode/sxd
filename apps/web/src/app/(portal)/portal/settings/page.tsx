import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PageHeader } from '@simplexd/ui';
import { getNotificationPreferences } from '@/server/portal/notification-preferences';
import { listConsents } from '@/server/portal/profile';
import { listMembers, listMemberships, listPendingInvitations } from '@/server/portal/organizations';
import { ConsentsSection } from './consents-section';
import { DangerZone } from './danger-zone';
import { NotificationPreferencesForm } from './notification-preferences-form';
import { OrganizationSettings } from './organization-settings';
import { ProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'organisation', label: 'Organisation' },
  { id: 'consents', label: 'Consents' },
  { id: 'danger', label: 'Account deletion' },
];

export default async function SettingsPage() {
  const identity = await requireSignedIn('/portal/settings');
  const user = identity.session!.user;
  const [memberships, members, invitations, consents, notificationPreferences] = await Promise.all([
    listMemberships(identity),
    listMembers(identity).catch(() => []),
    listPendingInvitations(identity).catch(() => []),
    listConsents(identity),
    getNotificationPreferences(identity),
  ]);
  const active = memberships.find((m) => m.isActive) ?? null;
  const marketingGranted = consents.find((c) => c.purpose === 'marketing_email')?.granted ?? false;
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Your profile, notifications, organisation and privacy choices." />
      <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="sx-touch inline-flex items-center rounded-full border border-border px-3 text-sm text-fg-muted hover:text-fg">
            {s.label}
          </a>
        ))}
      </nav>
      <section id="profile" aria-labelledby="profile-heading" className="scroll-mt-24 space-y-4">
        <h2 id="profile-heading" className="text-lg font-semibold">
          Profile
        </h2>
        <ProfileForm
          name={user.name}
          email={user.email}
          emailVerified={Boolean((user as { emailVerified?: boolean }).emailVerified)}
          phoneE164={identity.profile?.phoneE164 ?? null}
          phoneVerified={Boolean(identity.profile?.phoneVerifiedAt)}
          timeZone={identity.profile?.timeZone ?? 'Africa/Lagos'}
          countryOfResidence={identity.profile?.countryOfResidence ?? null}
        />
      </section>
      <section id="notifications" aria-labelledby="notifications-heading" className="scroll-mt-24 space-y-4">
        <h2 id="notifications-heading" className="text-lg font-semibold">
          Notifications
        </h2>
        <NotificationPreferencesForm initial={notificationPreferences} hasPhone={Boolean(identity.profile?.phoneE164)} />
      </section>
      <section id="organisation" aria-labelledby="organisation-heading" className="scroll-mt-24 space-y-4">
        <h2 id="organisation-heading" className="text-lg font-semibold">
          Organisation
        </h2>
        <OrganizationSettings
          active={active}
          memberships={memberships}
          members={members}
          invitations={invitations}
          currentUserId={user.id}
        />
      </section>
      <section id="consents" aria-labelledby="consents-heading" className="scroll-mt-24 space-y-4">
        <h2 id="consents-heading" className="text-lg font-semibold">
          Consents
        </h2>
        <ConsentsSection consents={consents} marketingGranted={marketingGranted} timeZone={identity.profile?.timeZone ?? 'Africa/Lagos'} />
      </section>
      <section id="danger" aria-labelledby="danger-heading" className="scroll-mt-24 space-y-4">
        <h2 id="danger-heading" className="text-lg font-semibold">
          Account deletion
        </h2>
        <DangerZone email={user.email} />
      </section>
    </div>
  );
}
