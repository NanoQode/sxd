import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { notificationChannelSchema, templateKeySchema } from '@simplexd/contracts';
import { PageHeader, buttonVariants } from '@simplexd/ui';
import { LoadError } from '@/components/admin/load-error';
import { attempt } from '@/lib/admin/server/context';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { templateFamily } from '@/server/admin/communications/service';
import { CHANNEL_LABELS } from '../../../_lib/labels';
import { TemplateEditor } from './template-editor';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ key: string; channel: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { key, channel } = await params;
  return { title: `Template · ${key} (${channel})` };
}

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

/**
 * Template family editor: version history (nothing is ever overwritten),
 * edit-as-new-version with a server-rendered sample preview, SMS segment,
 * encoding and cost estimate, activation and rollback.
 */
export default async function TemplateFamilyPage({
  params,
  searchParams,
}: Params & { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await params;
  const key = templateKeySchema.safeParse(raw.key);
  const channel = notificationChannelSchema.safeParse(raw.channel);
  if (!key.success || !channel.success) notFound();
  const identity = await requireSignedIn(
    `/admin/communications/templates/${raw.key}/${raw.channel}`,
  );
  const sp = await searchParams;
  const locale = first(sp['locale'])?.slice(0, 16) ?? 'en';
  const version = Number(first(sp['version']));
  const loaded = await attempt(() =>
    templateFamily(adminContext(identity), { key: key.data, channel: channel.data, locale }),
  );
  const header = (
    <PageHeader
      eyebrow="Templates"
      title={key.data}
      description={`${CHANNEL_LABELS[channel.data] ?? channel.data} · locale ${locale}. Approved versions are immutable: editing saves a new version, activating retires the previous one, and any older version can be rolled back to.`}
      actions={
        <Link
          href="/admin/communications/templates"
          className={buttonVariants({ variant: 'ghost' })}
        >
          All templates
        </Link>
      }
    />
  );
  if (!loaded.ok) {
    if (loaded.code === 'not_found') notFound();
    return (
      <div className="space-y-6">
        {header}
        <LoadError code={loaded.code} message={loaded.message} what="Template" />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      <TemplateEditor
        family={loaded.value}
        initialVersion={Number.isInteger(version) && version > 0 ? version : null}
      />
    </div>
  );
}
