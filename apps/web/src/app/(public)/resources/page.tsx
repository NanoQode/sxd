import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, buttonVariants, EmptyState, formatDateLabel, PageHeader } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { contentByKind, excerpt, fieldString, publicMetadata, siteUrl } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Resources',
  description:
    'Guides and explanations from the SimplexD team on evidence standards, service scopes, pricing bases and property processes in Nigeria.',
  path: '/resources',
});

export default async function ResourcesPage() {
  const resources = await contentByKind('resource');
  return (
    <>
      <Breadcrumbs items={[{ name: 'Resources', href: '/resources' }]} baseUrl={siteUrl()} />
      <div className="sx-container space-y-6 py-6">
        <PageHeader
          eyebrow="Resources"
          title="Guides and explanations"
          description="Reviewed, dated articles on how SimplexD works and how to read property evidence. Nothing here is investment or legal advice."
        />
        {resources.length === 0 ? (
          <EmptyState
            title="No resources published yet"
            description="Articles are written, reviewed and published through the content workflow. The service pages and evidence standards already explain how engagements run."
            action={
              <Link
                href="/how-it-works"
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                How it works
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {resources.map((r) => {
              const category = fieldString(r, 'category');
              return (
                <li
                  key={r.slug}
                  className="relative flex flex-col rounded-lg border border-border bg-bg-elevated p-5"
                >
                  {category ? <Badge tone="neutral">{category}</Badge> : null}
                  <h2 className="mt-2 text-lg font-semibold leading-tight">
                    <Link
                      href={`/resources/${r.slug}`}
                      className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {r.title}
                    </Link>
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">{excerpt(r, 200)}</p>
                  {r.publishedAt ? (
                    <p className="mt-3 text-xs text-fg-subtle">
                      Published {formatDateLabel(r.publishedAt)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <CtaBand />
    </>
  );
}
