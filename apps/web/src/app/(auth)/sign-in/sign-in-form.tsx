'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Field, Input } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

const schema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type Values = z.infer<typeof schema>;

export function SignInForm({ next, verified }: { next: string; verified: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const res = await authClient.signIn.email({
      email: values.email,
      password: values.password,
      callbackURL: next,
    });
    if (res.error) {
      setError(res.error.message ?? 'Sign in failed. Check your details and try again.');
      return;
    }
    const data = res.data as { twoFactorRedirect?: boolean } | null;
    if (data?.twoFactorRedirect) {
      router.push(`/two-factor?next=${encodeURIComponent(next)}`);
      return;
    }
    router.push(next);
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {verified ? (
        <Alert tone="success" title="Email verified">
          You can sign in now.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Could not sign in">
          {error}
        </Alert>
      ) : null}
      <Field label="Email" error={form.formState.errors.email?.message} required>
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
      <Field label="Password" error={form.formState.errors.password?.message} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...form.register('password')}
          />
        )}
      </Field>
      <div className="flex items-center justify-between">
        <Link href="/forgot-password" className="text-sm text-primary underline">
          Forgot password?
        </Link>
      </div>
      <Button
        type="submit"
        className="w-full"
        loading={form.formState.isSubmitting}
        loadingLabel="Signing in"
      >
        Sign in
      </Button>
    </form>
  );
}
