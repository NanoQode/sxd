import { rowsToCsv, type CsvColumn } from '@/lib/admin/csv';
import { CsvDownloadButton } from './csv-download-button';

/**
 * Downloads the rows currently shown as CSV (what you see is what you export).
 * Server-safe: the CSV text is built where the component renders, so column
 * accessor functions never cross from a server component to the client.
 */
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
    <CsvDownloadButton
      csv={rowsToCsv(rows, columns)}
      count={rows.length}
      filename={filename}
      label={label}
    />
  );
}
