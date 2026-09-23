'use client';

import { Download } from 'lucide-react';
import { Button } from '@simplexd/ui';
import { downloadCsv } from '@/lib/admin/csv';

/** Client half of the CSV export: receives the finished CSV text (serialisable) and saves it. */
export function CsvDownloadButton({
  csv,
  count,
  filename,
  label = 'Export CSV',
}: {
  csv: string;
  count: number;
  filename: string;
  label?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={count === 0}
      title={count === 0 ? 'Nothing to export' : `Export ${count} rows`}
      onClick={() => downloadCsv(filename, csv)}
    >
      <Download aria-hidden="true" className="h-4 w-4" />
      {label}
    </Button>
  );
}
