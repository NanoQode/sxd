'use client';

import { Download } from 'lucide-react';
import { Button } from '@simplexd/ui';
import { downloadCsv, rowsToCsv, type CsvColumn } from '@/lib/admin/csv';

/** Downloads the rows currently shown as CSV (what you see is what you export). */
export function ExportCsvButton<T>({
  rows,
  columns,
  filename,
  label = 'Export CSV',
}: {
  rows: T[];
  columns: CsvColumn<T>[];
  filename: string;
  label?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={rows.length === 0}
      title={rows.length === 0 ? 'Nothing to export' : `Export ${rows.length} rows`}
      onClick={() => downloadCsv(filename, rowsToCsv(rows, columns))}
    >
      <Download aria-hidden="true" className="h-4 w-4" />
      {label}
    </Button>
  );
}
