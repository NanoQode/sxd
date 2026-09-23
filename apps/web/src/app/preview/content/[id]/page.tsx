import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { Alert, Badge, ThemeToggle, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { getContentPageDetail } from '@/server/content/admin';

export const metadata: Metadata = {
  title: 'Content preview',
  robots: { index: false, follow: false, noarchive: true },
};
export const dynamic = 'force-dynamic';

/** Staff-only preview of any revision. Never indexed (X-Robots-Tag is also set for /preview). */
export default async function ContentPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rev?: string }>;
}) {
  const { id } = await params;
  const { rev } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireStaffPage('content.edit');
  const detail = await getContentPageDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!detail) notFound();
  const revisionNumber = rev ? Number(rev) : detail.currentRevision;
  const revision = detail.revisions.find((r) => r.revision === revisionNumber);
  if (!revision) notFound();
  const isLive = detail.publishedRevision === revision.revision && detail.status === 'published';
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-bg-elevated">
        <div className="sx-container flex h-14 items-center justify-between gap-3 text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">Preview</Badge>
            <span className="font-mono">/{detail.slug}</span>
            <span>revision {revision.revision}</span>
            <Badge tone={isLive ? 'success' : 'neutral'}>
              {isLive ? 'Live revision' : humanize(revision.reviewStatus)}
            </Badge>
          </span>
          <span className="flex items-center gap-2">
            <Link href={`/admin/content/${detail.id}`} className="text-primary underline">
              Back to editor
            </Link>
            <ThemeToggle compact />
          </span>
        </div>
      </header>
      <main className="sx-container flex-1 py-8">
        <Alert tone="info" className="mb-6">
          Staff-only preview of {detail.kind} “{detail.title}” as saved on{' '}
          {formatDateTimeLabel(revision.createdAt)}. This link is not public and is never indexed.
        </Alert>
        <article className="mx-auto max-w-3xl">
          <h1 className="font-display text-3xl font-semibold">{revision.title}</h1>
          {revision.summary ? (
            <p className="mt-2 text-lg text-fg-muted">{revision.summary}</p>
          ) : null}
          <div
            className="sx-prose mt-6"
            dangerouslySetInnerHTML={{ __html: revision.bodyHtmlSanitized ?? '' }}
          />
          {revision.fields && Object.keys(revision.fields).length > 0 ? (
            <section className="mt-8">
              <h2 className="text-base font-semibold">Structured fields</h2>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-bg-sunken p-3 text-xs">
                {JSON.stringify(revision.fields, null, 2)}
              </pre>
            </section>
          ) : null}
        </article>
      </main>
    </div>
  );
}
