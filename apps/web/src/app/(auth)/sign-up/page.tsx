import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@simplexd/ui';
import { getSession } from '@/lib/auth/session';
import { resumeIntentFromNext, resumeMessage } from '@/lib/explorer/resume-intents';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/onboarding';
  if (await getSession()) redirect(safeNext);
  const resume = resumeIntentFromNext(safeNext);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>
          {resume
            ? resumeMessage(resume).replace(/^Sign in to/, 'Create an account to')
            : 'Save plans, request services and follow your projects with evidence.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignUpForm next={safeNext} />
        <p className="mt-4 text-sm text-fg-muted">
          Already have an account?{' '}
          <Link
            href={next ? `/sign-in?next=${encodeURIComponent(safeNext)}` : '/sign-in'}
            className="text-primary underline"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
