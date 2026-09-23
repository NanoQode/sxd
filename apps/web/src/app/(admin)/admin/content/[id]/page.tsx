import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { authorizeStaff } from '@simplexd/domain/authz';
import { PageHeader, StatusBadge } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { getContentPageDetail } from '@/server/content/admin';
import { ContentEditor } from './content-editor';

export const metadata: Metadata = { title: 'Edit content' };
export const dynamic = 'force-dynamic';

export default async function ContentEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireStaffPage('content.edit');
  const detail = await getContentPageDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!detail) notFound();
  const canPublish = authorizeStaff(identity.actor, 'content.publish').allowed;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/content" className="underline">
            Content
          </Link>
        }
        title={detail.title}
        description={
          <span className="font-mono text-sm">
            /{detail.slug} · {detail.kind}
          </span>
        }
        actions={<StatusBadge status={detail.status} />}
      />
      <ContentEditor
        detail={detail}
        canPublish={canPublish}
        currentUserId={identity.session!.user.id}
      />
    </div>
  );
}
