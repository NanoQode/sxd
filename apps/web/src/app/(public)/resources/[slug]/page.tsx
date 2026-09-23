import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatDateLabel } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { Prose } from '@/components/public/section';
import { contentBySlug, excerpt, publicMetadata, siteUrl } from '../../_lib/site-data';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const page = await contentBySlug(slug, 'resource');
  if (!page) return { title: 'Resource not found', robots: { index: false, follow: false } };
  return publicMetadata({
    title: page.seo?.title ?? page.title,
    description: page.seo?.description ?? excerpt(page),
    path: `/resources/${page.slug}`,
    type: 'article',
    noindex: Boolean(page.seo?.noindex),
  });
}

export default async function ResourceDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const page = await contentBySlug(slug, 'resource');
  if (!page) notFound();
  return (
    <>
      <Breadcrumbs
        items={[
          { name: 'Resources', href: '/resources' },
          { name: page.title, href: `/resources/${page.slug}` },
        ]}
        baseUrl={siteUrl()}
      />
      <article className="sx-container py-6">
        <header className="max-w-prose">
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{page.title}</h1>
          {page.publishedAt ? (
            <p className="mt-2 text-sm text-fg-muted">Published {formatDateLabel(page.publishedAt)}</p>
          ) : null}
        </header>
        <Prose html={page.bodyHtml} className="mt-6" />
      </article>
      <CtaBand />
    </>
  );
}
