import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert, formatDateLabel } from '@simplexd/ui';
import { renderMarkdown } from '@/lib/markdown';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { DEFAULT_POLICIES, POLICY_TEMPLATE_NOTICE } from '@/components/public/defaults';
import { Prose } from '@/components/public/section';
import { contentBySlug, fieldString, publicMetadata, siteUrl } from '../../_lib/site-data';

type Params = Promise<{ slug: string }>;

interface PolicyView {
  slug: string;
  title: string;
  bodyHtml: string;
  reviewed: boolean;
  effectiveDate: string | null;
  version: string | null;
  publishedAt: string | null;
}

async function loadPolicy(slug: string): Promise<PolicyView | null> {
  const cms = await contentBySlug(slug, 'policy');
  if (cms) {
    return {
      slug,
      title: cms.title,
      bodyHtml: cms.bodyHtml,
      reviewed: cms.fields.reviewStatus === 'reviewed',
      effectiveDate: fieldString(cms, 'effectiveDate'),
      version: fieldString(cms, 'version'),
      publishedAt: cms.publishedAt,
    };
  }
  if (slug === 'privacy' || slug === 'terms') {
    const d = DEFAULT_POLICIES[slug];
    return {
      slug,
      title: d.title,
      bodyHtml: renderMarkdown(d.markdown),
      reviewed: false,
      effectiveDate: null,
      version: null,
      publishedAt: null,
    };
  }
  return null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const policy = await loadPolicy(slug);
  if (!policy) return { title: 'Policy not found', robots: { index: false, follow: false } };
  return publicMetadata({
    title: policy.title,
    description: `${policy.title} for the SimplexD website and customer portal.${policy.reviewed ? '' : ' Template pending legal review.'}`,
    path: `/policies/${policy.slug}`,
    noindex: !policy.reviewed,
  });
}

export default async function PolicyPage({ params }: { params: Params }) {
  const { slug } = await params;
  const policy = await loadPolicy(slug);
  if (!policy) notFound();
  return (
    <>
      <Breadcrumbs items={[{ name: policy.title, href: `/policies/${policy.slug}` }]} baseUrl={siteUrl()} />
      <article className="sx-container py-6">
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{policy.title}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {policy.version ? `Version ${policy.version} · ` : ''}
          {policy.effectiveDate
            ? `Effective ${formatDateLabel(policy.effectiveDate)}`
            : policy.publishedAt
              ? `Published ${formatDateLabel(policy.publishedAt)}`
              : 'Not yet effective'}
        </p>
        {!policy.reviewed ? (
          <Alert tone="warning" title="Template pending legal review" className="mt-4 max-w-prose">
            {POLICY_TEMPLATE_NOTICE}
          </Alert>
        ) : null}
        <Prose html={policy.bodyHtml} className="mt-6" />
      </article>
    </>
  );
}
