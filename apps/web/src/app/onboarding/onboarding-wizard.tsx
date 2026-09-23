'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { GOAL_OPTIONS } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { authClient } from '@/lib/auth/client';
import { timeZoneOptions } from '@/app/(portal)/portal/settings/profile-form';

interface Membership {
  organizationId: string;
  name: string;
  role: string;
  isActive: boolean;
}

interface Profile {
  timeZone: string | null;
  phoneE164: string | null;
  countryOfResidence: string | null;
  diaspora: boolean | null;
  goals: string[];
  onboardingCompletedAt: string | null;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'org'}-${suffix}`;
}

const orgSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name, e.g. your family name or company').max(120),
  ownershipType: z.enum(['individual', 'company']),
});
type OrgValues = z.infer<typeof orgSchema>;

const profileSchema = z.object({
  timeZone: z.string().min(1, 'Choose a time zone'),
  phone: z.string().trim().max(32).optional(),
  countryOfResidence: z.string().trim().length(2, 'Two-letter country code').or(z.literal('')),
  diaspora: z.enum(['yes', 'no', '']),
  goals: z.array(z.string()).max(10),
});
type ProfileValues = z.infer<typeof profileSchema>;

export function OnboardingWizard({
  next,
  userName,
  emailVerified,
  memberships,
  profile,
}: {
  next: string;
  userName: string;
  emailVerified: boolean;
  memberships: Membership[];
  profile: Profile;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'organisation' | 'profile'>(
    memberships.length > 0 ? 'profile' : 'organisation',
  );
  const [error, setError] = useState<string | null>(null);
  const [createdOrg, setCreatedOrg] = useState<string | null>(null);
  const zones = useMemo(() => timeZoneOptions(), []);
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lagos';
    } catch {
      return 'Africa/Lagos';
    }
  }, []);

  const orgForm = useForm<OrgValues>({
    resolver: zodResolver(orgSchema),
    defaultValues: { name: '', ownershipType: 'individual' },
  });
  const profileForm = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      timeZone:
        profile.timeZone && profile.timeZone !== 'Africa/Lagos' ? profile.timeZone : detected,
      phone: profile.phoneE164 ?? '',
      countryOfResidence: profile.countryOfResidence ?? '',
      diaspora: profile.diaspora === null ? '' : profile.diaspora ? 'yes' : 'no',
      goals: profile.goals,
    },
  });

  const createOrganisation = orgForm.handleSubmit(async (values) => {
    setError(null);
    const res = await authClient.organization.create({
      name: values.name,
      slug: slugify(values.name),
    });
    if (res.error || !res.data) {
      setError(res.error?.message ?? 'Could not create the organisation.');
      return;
    }
    const active = await authClient.organization.setActive({ organizationId: res.data.id });
    if (active.error) {
      setError(active.error.message ?? 'Organisation created, but it could not be activated.');
      return;
    }
    try {
      await apiFetch('/api/v1/me/organizations', {
        method: 'PATCH',
        body: { ownershipType: values.ownershipType },
      });
      await apiFetch('/api/v1/me/preferences', {
        method: 'PATCH',
        body: { ownershipType: values.ownershipType },
      });
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    queryClient.clear();
    setCreatedOrg(values.name);
    setStep('profile');
    router.refresh();
  });

  const saveProfile = profileForm.handleSubmit(async (values) => {
    setError(null);
    try {
      const prefs: Record<string, unknown> = { timeZone: values.timeZone, goals: values.goals };
      if (values.countryOfResidence)
        prefs['countryOfResidence'] = values.countryOfResidence.toUpperCase();
      if (values.diaspora) prefs['diaspora'] = values.diaspora === 'yes';
      await apiFetch('/api/v1/me/preferences', { method: 'PATCH', body: prefs });
      if ((values.phone ?? '') !== (profile.phoneE164 ?? '')) {
        await apiFetch('/api/v1/me/phone', {
          method: 'PATCH',
          body: {
            phone: values.phone ? values.phone : null,
            defaultCountry: values.countryOfResidence || 'NG',
          },
        });
      }
      await apiFetch('/api/v1/me/onboarding', { method: 'POST', body: { goals: values.goals } });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  async function skipProfile() {
    setError(null);
    try {
      await apiFetch('/api/v1/me/onboarding', { method: 'POST', body: {} });
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    router.push(next);
    router.refresh();
  }

  const goals = profileForm.watch('goals');

  return (
    <div className="space-y-6">
      <ol className="flex gap-4 text-sm" aria-label="Onboarding steps">
        <li className={step === 'organisation' ? 'font-semibold text-primary' : 'text-fg-muted'}>
          1. Organisation
        </li>
        <li className={step === 'profile' ? 'font-semibold text-primary' : 'text-fg-muted'}>
          2. Profile
        </li>
      </ol>
      {!emailVerified ? (
        <Alert tone="warning" title="Email not verified yet">
          Check your inbox for the verification link. You can continue setting up; some actions wait
          for a verified email.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Could not continue">
          {error}
        </Alert>
      ) : null}

      {step === 'organisation' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              Welcome, {userName.split(' ')[0]}. Set up your organisation
            </CardTitle>
            <CardDescription>
              Requests, documents and invoices belong to an organisation so household members and
              advisers can share them. You can belong to several and switch at any time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={createOrganisation} noValidate className="space-y-4">
              <Field
                label="Organisation name"
                required
                hint="A family name, a company or simply your own name."
                error={orgForm.formState.errors.name?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    autoComplete="organization"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...orgForm.register('name')}
                  />
                )}
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Ownership</legend>
                {(['individual', 'company'] as const).map((v) => (
                  <label
                    key={v}
                    className="flex items-start gap-2 rounded-md border border-border p-3 text-sm has-[:checked]:border-primary"
                  >
                    <input
                      type="radio"
                      value={v}
                      className="mt-1 accent-[var(--sx-primary)]"
                      {...orgForm.register('ownershipType')}
                    />
                    <span>
                      <span className="font-medium">
                        {v === 'individual' ? 'Individual or household' : 'Company'}
                      </span>
                      <br />
                      <span className="text-fg-muted">
                        {v === 'individual'
                          ? 'Property owned personally or by a family. Identity documents are requested only when a transaction needs them.'
                          : 'A registered company. Company documents are requested only when a transaction needs them.'}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <Button
                type="submit"
                className="w-full"
                loading={orgForm.formState.isSubmitting}
                loadingLabel="Creating organisation"
              >
                Create organisation
              </Button>
              <p className="text-center text-sm text-fg-muted">
                Received an invitation? Open the link in the email to join an existing organisation
                instead.
              </p>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              {createdOrg ? `${createdOrg} is ready.` : 'Your profile'}
            </CardTitle>
            <CardDescription>
              {memberships.length > 0 && !createdOrg ? (
                <>
                  You already belong to{' '}
                  {memberships.map((m) => (
                    <Badge key={m.organizationId} tone="primary" className="mr-1">
                      {m.name}
                    </Badge>
                  ))}
                  .{' '}
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => setStep('organisation')}
                  >
                    Create another organisation
                  </button>
                </>
              ) : (
                'A few details help us schedule in your time zone and tailor what you see. Everything here is optional.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} noValidate className="space-y-4">
              <Field
                label="Time zone"
                required
                hint={`Detected from your device: ${detected}.`}
                error={profileForm.formState.errors.timeZone?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <div className="flex flex-wrap items-center gap-2">
                    <NativeSelect
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      className="max-w-md"
                      {...profileForm.register('timeZone')}
                    >
                      {zones.map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => profileForm.setValue('timeZone', detected)}
                    >
                      Use detected
                    </Button>
                  </div>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Phone (optional)"
                  hint="International format is safest, e.g. +234 801 234 5678."
                  error={profileForm.formState.errors.phone?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      {...profileForm.register('phone')}
                    />
                  )}
                </Field>
                <Field
                  label="Country of residence"
                  hint="Two-letter code, e.g. NG, GB, US, CA."
                  error={profileForm.formState.errors.countryOfResidence?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      maxLength={2}
                      autoComplete="country"
                      className="uppercase"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      {...profileForm.register('countryOfResidence')}
                    />
                  )}
                </Field>
              </div>
              <Field label="Do you live outside Nigeria?">
                {({ id }) => (
                  <NativeSelect id={id} className="max-w-xs" {...profileForm.register('diaspora')}>
                    <option value="">Prefer not to say</option>
                    <option value="yes">Yes, I am in the diaspora</option>
                    <option value="no">No, I live in Nigeria</option>
                  </NativeSelect>
                )}
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">What do you want to achieve?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {GOAL_OPTIONS.map((g) => (
                    <label
                      key={g.value}
                      className="flex items-center gap-2 rounded-md border border-border p-3 text-sm has-[:checked]:border-primary"
                    >
                      <input
                        type="checkbox"
                        value={g.value}
                        className="accent-[var(--sx-primary)]"
                        {...profileForm.register('goals')}
                      />
                      {g.label}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-fg-subtle">
                  {goals.length === 0
                    ? 'Pick any that apply, or skip.'
                    : `${goals.length} selected.`}
                </p>
              </fieldset>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void skipProfile()}
                  disabled={profileForm.formState.isSubmitting}
                >
                  Skip for now
                </Button>
                <Button
                  type="submit"
                  loading={profileForm.formState.isSubmitting}
                  loadingLabel="Saving"
                >
                  Save and continue
                </Button>
              </div>
              <p className="text-center text-xs text-fg-subtle">
                You can change all of this later in{' '}
                <Link href="/portal/settings" className="underline">
                  Settings
                </Link>
                .
              </p>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
