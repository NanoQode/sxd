import type { Metadata } from 'next';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@simplexd/ui';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>Passwords need at least 12 characters.</CardDescription>
      </CardHeader>
      <CardContent>
        {error || !token ? (
          <Alert tone="danger" title="This reset link is invalid or has expired">
            Request a new link from the sign-in page.
          </Alert>
        ) : (
          <ResetPasswordForm token={token} />
        )}
      </CardContent>
    </Card>
  );
}
