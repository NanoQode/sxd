import fs from 'node:fs/promises';
import path from 'node:path';
import type { Metadata } from 'next';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { renderMarkdown } from '@/lib/markdown';

export const metadata: Metadata = { title: 'Implementation status' };
export const dynamic = 'force-dynamic';

async function loadStatus(): Promise<string | null> {
  const candidates = [
    path.resolve(process.cwd(), 'IMPLEMENTATION-STATUS.md'),
    path.resolve(process.cwd(), '../../IMPLEMENTATION-STATUS.md'),
  ];
  for (const file of candidates) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/** Renders the repository's IMPLEMENTATION-STATUS.md so planned sections can link to it. */
export default async function ImplementationStatusPage() {
  await requireSignedIn('/admin/implementation-status');
  const markdown = await loadStatus();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Implementation status"
        description="Requirement-by-requirement account of the build against the brief, maintained in the repository as IMPLEMENTATION-STATUS.md."
      />
      {markdown ? (
        <article
          className="sx-prose max-w-none text-sm"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }}
        />
      ) : (
        <Alert tone="info" title="Status file not bundled in this deployment">
          Read <code>IMPLEMENTATION-STATUS.md</code> at the repository root. The file is not copied
          into the standalone build.
        </Alert>
      )}
    </div>
  );
}
