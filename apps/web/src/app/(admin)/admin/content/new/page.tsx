import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { NewPageForm } from './new-page-form';

export const metadata: Metadata = { title: 'New content page' };
export const dynamic = 'force-dynamic';

export default async function NewContentPage() {
  await requireStaffPage('content.edit');
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/content" className="underline">
            Content
          </Link>
        }
        title="New page"
        description="Creates a draft with revision 1. Structured kinds (FAQ, contact, navigation, goal path…) carry their data in the fields JSON."
      />
      <NewPageForm />
    </div>
  );
}
