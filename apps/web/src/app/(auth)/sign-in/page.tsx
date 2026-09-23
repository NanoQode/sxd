import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@simplexd/ui';
import { getSession } from '@/lib/auth/session';
import { resumeIntentFromNext, resumeMessage } from '@/lib/explorer/account-gate';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/portal';
  return next;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; verified?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getSession();
  if (session) redirect(next);
  const resume = resumeIntentFromNext(next);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign in</CardTitle>
        <CardDescription>
          {resume
            ? resumeMessage(resume)
            : 'Access your portal, projects, documents and appointments.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignInForm next={next} verified={params.verified === '1'} />
        <p className="mt-4 text-sm text-fg-muted">
          New to SimplexD?{' '}
          <Link
            href={`/sign-up?next=${encodeURIComponent(next)}`}
            className="text-primary underline"
          >
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
