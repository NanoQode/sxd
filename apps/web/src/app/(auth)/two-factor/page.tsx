import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@simplexd/ui';
import { TwoFactorForm } from './two-factor-form';

export const metadata: Metadata = { title: 'Two-factor verification' };

export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/portal';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Two-factor verification</CardTitle>
        <CardDescription>
          Enter the 6-digit code from your authenticator app, or a backup code.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TwoFactorForm next={safeNext} />
      </CardContent>
    </Card>
  );
}
