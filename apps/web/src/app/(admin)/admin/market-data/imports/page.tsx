import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { OBSERVATION_CSV_COLUMNS, listImports } from '@/server/admin/market-data/imports';
import { ImportsManager } from './imports-manager';

export const metadata: Metadata = { title: 'Imports' };
export const dynamic = 'force-dynamic';

export default async function ImportsPage() {
  const identity = await requireStaffPage('market_data.import');
  const items = await listImports(adminContext(identity));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Imports"
        description="Preview a research seed (JSON) or an observations CSV before anything is written. Re-imports never overwrite human edits: conflicts are listed for review."
      />
      <ImportsManager items={items} csvColumns={OBSERVATION_CSV_COLUMNS} />
    </div>
  );
}
