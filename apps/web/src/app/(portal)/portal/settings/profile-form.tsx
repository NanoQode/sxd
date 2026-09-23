'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
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
  ReduceMotionToggle,
  ThemeToggle,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { authClient } from '@/lib/auth/client';

const FALLBACK_ZONES = [
  'Africa/Lagos',
  'Africa/Accra',
  'Africa/Johannesburg',
  'Africa/Nairobi',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

export function timeZoneOptions(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    if (supported && supported.length > 0) return supported;
  } catch {
    /* fall back */
  }
  return FALLBACK_ZONES;
}

const schema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120),
  phone: z.string().trim().max(32).optional(),
  timeZone: z.string().min(1, 'Choose a time zone'),
  countryOfResidence: z.string().length(2, 'Two-letter country code').or(z.literal('')).optional(),
});
type Values = z.infer<typeof schema>;

export function ProfileForm({
  name,
  email,
  emailVerified,
  phoneE164,
  phoneVerified,
  timeZone,
  countryOfResidence,
}: {
  name: string;
  email: string;
  emailVerified: boolean;
  phoneE164: string | null;
  phoneVerified: boolean;
  timeZone: string;
  countryOfResidence: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => {
    const list = timeZoneOptions();
    return list.includes(timeZone) ? list : [timeZone, ...list];
  }, [timeZone]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name,
      phone: phoneE164 ?? '',
      timeZone,
      countryOfResidence: countryOfResidence ?? '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (values.name !== name) {
        const res = await authClient.updateUser({ name: values.name });
        if (res.error) throw new Error(res.error.message ?? 'Could not update your name.');
      }
      if ((values.phone ?? '') !== (phoneE164 ?? '')) {
        await apiFetch('/api/v1/me/phone', {
          method: 'PATCH',
          body: {
            phone: values.phone ? values.phone : null,
            defaultCountry: values.countryOfResidence || 'NG',
          },
        });
      }
      const prefs: Record<string, unknown> = {};
      if (values.timeZone !== timeZone) prefs['timeZone'] = values.timeZone;
      if (
        (values.countryOfResidence ?? '') !== (countryOfResidence ?? '') &&
        values.countryOfResidence
      )
        prefs['countryOfResidence'] = values.countryOfResidence.toUpperCase();
      if (Object.keys(prefs).length > 0)
        await apiFetch('/api/v1/me/preferences', { method: 'PATCH', body: prefs });
      toast({ title: 'Profile saved', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  function detectTimeZone() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) form.setValue('timeZone', detected, { shouldDirty: true });
  }

  const errors = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your details</CardTitle>
        <CardDescription>
          Your email is your sign-in identity; contact support to change it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {error ? (
            <Alert tone="danger" title="Could not save">
              {error}
            </Alert>
          ) : null}
          <Field label="Email">
            {({ id }) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input id={id} value={email} readOnly aria-readonly className="max-w-md" />
                {emailVerified ? (
                  <Badge tone="success">Verified</Badge>
                ) : (
                  <Badge tone="warning">Not verified</Badge>
                )}
              </div>
            )}
          </Field>
          <Field label="Full name" required error={errors.name?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                autoComplete="name"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="max-w-md"
                {...form.register('name')}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Phone"
              hint="Optional. International format is safest (+234…); local numbers use your country of residence."
              error={errors.phone?.message}
            >
              {({ id, describedBy, invalid }) => (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={id}
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    className="max-w-xs"
                    {...form.register('phone')}
                  />
                  {phoneE164 ? (
                    phoneVerified ? (
                      <Badge tone="success">Verified</Badge>
                    ) : (
                      <Badge tone="neutral">Unverified</Badge>
                    )
                  ) : null}
                </div>
              )}
            </Field>
            <Field
              label="Country of residence"
              hint="Two-letter code, e.g. NG, GB, US."
              error={errors.countryOfResidence?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  maxLength={2}
                  autoComplete="country"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="max-w-[8rem] uppercase"
                  {...form.register('countryOfResidence')}
                />
              )}
            </Field>
          </div>
          <Field
            label="Time zone"
            required
            hint="Appointments show in this zone alongside Africa/Lagos."
            error={errors.timeZone?.message}
          >
            {({ id, describedBy, invalid }) => (
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="max-w-md"
                  {...form.register('timeZone')}
                >
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </NativeSelect>
                <Button type="button" variant="secondary" size="sm" onClick={detectTimeZone}>
                  Detect from device
                </Button>
              </div>
            )}
          </Field>
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Appearance</p>
            <p className="text-sm text-fg-muted">
              Saved to your profile immediately; your choice overrides any organisation default.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <ThemeToggle />
              <ReduceMotionToggle />
            </div>
          </div>
          <Button type="submit" loading={form.formState.isSubmitting} loadingLabel="Saving">
            Save profile
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
