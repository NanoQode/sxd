import type { FileDto, FileEntityType, FilePurpose } from '@simplexd/contracts';
import { DataTable, EmptyState, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { formatBytes } from '@/lib/portal/format';
import { FileStatusBadge } from './file-status';
import { FileUploader } from './file-uploader';
import { SignedDownloadButton } from './signed-download';

/**
 * Files attached to a record: the list (with live scan status and signed
 * downloads) plus the uploader when the caller may upload.
 */
export function FilesPanel({
  files,
  entityType,
  entityId,
  purpose,
  zone,
  canUpload,
  cannotUploadReason,
  caption = 'Files',
  emptyDescription = 'No files have been shared on this record yet.',
}: {
  files: FileDto[];
  entityType: FileEntityType;
  entityId: string;
  purpose: FilePurpose;
  zone: string;
  canUpload: boolean;
  cannotUploadReason?: string;
  caption?: string;
  emptyDescription?: string;
}) {
  return (
    <div className="space-y-4">
      <FileUploader
        purpose={purpose}
        entityType={entityType}
        entityId={entityId}
        disabled={!canUpload}
        disabledReason={cannotUploadReason}
      />
      {files.length === 0 ? (
        <EmptyState title="No files yet" description={emptyDescription} />
      ) : (
        <DataTable
          caption={caption}
          rows={files}
          rowKey={(f) => f.id}
          rowLabel={(f) => f.originalName}
          columns={[
            {
              key: 'name',
              header: 'File',
              cell: (f) => <span className="font-medium break-all">{f.originalName}</span>,
            },
            {
              key: 'purpose',
              header: 'Purpose',
              cell: (f) => humanize(String(f.purpose)),
              hideOnMobile: true,
            },
            {
              key: 'size',
              header: 'Size',
              cell: (f) => formatBytes(f.sizeBytes),
              hideOnMobile: true,
            },
            {
              key: 'status',
              header: 'Scan',
              cell: (f) => (
                <FileStatusBadge fileId={f.id} status={f.status} reason={f.statusReason} />
              ),
            },
            { key: 'added', header: 'Added', cell: (f) => formatDateTimeLabel(f.createdAt, zone) },
            {
              key: 'download',
              header: <span className="sr-only">Download</span>,
              mobileLabel: 'Download',
              cell: (f) => (
                <SignedDownloadButton fileId={f.id} fileName={f.originalName} status={f.status} />
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
