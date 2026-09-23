'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Field, Input } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

const schema = z
  .object({
    name: z.string().trim().min(2, 'Enter your name').max(120),
    email: z.email('Enter a valid email address'),
    password: z.string().min(12, 'Use at least 12 characters').max(256),
    confirm: z.string(),
    consent: z.literal(true, { error: 'Please accept the privacy notice to continue' }),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });
type Values = z.infer<typeof schema>;

export function SignUpForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirm: '',
      consent: undefined as unknown as true,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const res = await authClient.signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
      callbackURL: `/sign-in?verified=1&next=${encodeURIComponent(next)}`,
    });
    if (res.error) {
      setError(res.error.message ?? 'Could not create the account.');
      return;
    }
    await fetch('/api/v1/me/consents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'privacy_notice', granted: true, source: 'sign_up' }),
    }).catch(() => undefined);
    const session = await authClient.getSession();
    if (session.data?.session) {
      router.push(next);
      router.refresh();
    } else {
      setSent(true);
    }
  });

  if (sent) {
    return (
      <Alert tone="success" title="Check your email">
        We sent a verification link to confirm your address. Open it to finish creating your
        account.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error ? (
        <Alert tone="danger" title="Could not create account">
          {error}
        </Alert>
      ) : null}
      <Field label="Full name" error={form.formState.errors.name?.message} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            autoComplete="name"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...form.register('name')}
          />
        )}
      </Field>
      <Field
        label="Email"
        error={form.formState.errors.email?.message}
        required
        hint="We will send a verification link."
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            inputMode="email"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...form.register('email')}
          />
        )}
      </Field>
      <Field
        label="Password"
        error={form.formState.errors.password?.message}
        required
        hint="At least 12 characters."
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...form.register('password')}
          />
        )}
      </Field>
      <Field label="Confirm password" error={form.formState.errors.confirm?.message} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...form.register('confirm')}
          />
        )}
      </Field>
      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            {...form.register('consent')}
            aria-invalid={Boolean(form.formState.errors.consent)}
          />
          <span>
            I have read the{' '}
            <a
              href="/policies/privacy"
              className="text-primary underline"
              target="_blank"
              rel="noreferrer"
            >
              privacy notice
            </a>{' '}
            and agree to the{' '}
            <a
              href="/policies/terms"
              className="text-primary underline"
              target="_blank"
              rel="noreferrer"
            >
              terms
            </a>
            .
          </span>
        </label>
        {form.formState.errors.consent ? (
          <p role="alert" className="text-sm text-danger">
            {form.formState.errors.consent.message}
          </p>
        ) : null}
      </div>
      <Button
        type="submit"
        className="w-full"
        loading={form.formState.isSubmitting}
        loadingLabel="Creating account"
      >
        Create account
      </Button>
    </form>
  );
}
