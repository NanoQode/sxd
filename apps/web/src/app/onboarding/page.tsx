import { requireSignedIn } from '@/lib/auth/session';
import { listMemberships } from '@/server/portal/organizations';
import { OnboardingWizard } from './onboarding-wizard';

export const dynamic = 'force-dynamic';

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/portal';
  return next;
}

/**
 * Customer onboarding: organisation (required), then profile details (skippable).
 * Verified email is handled by sign-up; phone stays optional.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const identity = await requireSignedIn(`/onboarding${params.next ? `?next=${encodeURIComponent(params.next)}` : ''}`);
  const memberships = await listMemberships(identity);
  const profile = identity.profile;
  return (
    <OnboardingWizard
      next={safeNext(params.next)}
      userName={identity.session!.user.name}
      emailVerified={Boolean((identity.session!.user as { emailVerified?: boolean }).emailVerified)}
      memberships={memberships.map((m) => ({ organizationId: m.organizationId, name: m.name, role: m.role, isActive: m.isActive }))}
      profile={{
        timeZone: profile?.timeZone ?? null,
        phoneE164: profile?.phoneE164 ?? null,
        countryOfResidence: profile?.countryOfResidence ?? null,
        diaspora: profile?.diaspora ?? null,
        goals: profile?.goals ?? [],
        onboardingCompletedAt: profile?.onboardingCompletedAt?.toISOString() ?? null,
      }}
    />
  );
}
