import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  PageHeader,
  formatDateLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { formatBytes } from '@/lib/portal/format';
import { loadDocumentLibrary } from '@/lib/portal/server/documents';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { FileStatusBadge } from '@/components/portal/file-status';
import { FileUploader } from '@/components/portal/file-uploader';
import { GrantsDisclosure } from '@/components/portal/grants-disclosure';
import { SignedDownloadButton } from '@/components/portal/signed-download';
import { listDocuments } from '@/server/portal/lists';

export const metadata: Metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const identity = await requireSignedIn('/portal/documents');
  const { folder } = await searchParams;
  const caps = customerCapabilities(identity);
  const [folders, { reports }] = await Promise.all([
    loadDocumentLibrary(identity),
    listDocuments(identity),
  ]);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const total = folders.reduce((n, f) => n + f.items.length, 0);
  const active =
    folders.find((f) => f.key === folder) ?? folders.find((f) => f.items.length > 0) ?? folders[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Your organisation's document library, grouped by the record each file belongs to. Downloads use time-limited signed links and are logged; files are scanned before anyone can open them."
      />
      <Card>
        <CardHeader>
          <CardTitle>Upload to the organisation library</CardTitle>
          <CardDescription>
            Contracts, letters, surveys and anything the team asked for. Attach files to a request,
            project or property from that record instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FileUploader
            purpose="org_document"
            disabled={!caps.uploadDocuments}
            disabledReason={capabilityNote(caps, 'Uploading documents')}
          />
        </CardContent>
      </Card>

      {total === 0 ? (
        <EmptyState
          title="No files yet"
          description="Uploads you make and files the team shares with you appear here, grouped by request, project and property."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <nav aria-label="Folders" className="lg:sticky lg:top-4 lg:self-start">
            <ul className="flex gap-2 overflow-x-auto lg:flex-col">
              {folders.map((f) => (
                <li key={f.key} className="shrink-0">
                  <Link
                    href={`/portal/documents?folder=${f.key}`}
                    aria-current={active?.key === f.key ? 'page' : undefined}
                    className={`sx-touch flex items-center justify-between gap-3 rounded-md px-3 text-sm ${active?.key === f.key ? 'bg-primary-soft font-medium text-primary' : 'text-fg-muted hover:bg-bg-sunken hover:text-fg'}`}
                  >
                    {f.label}
                    <Badge tone={f.items.length > 0 ? 'neutral' : 'neutral'}>
                      {f.items.length}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {active ? (
            <Card>
              <CardHeader>
                <CardTitle>{active.label}</CardTitle>
                <CardDescription>{active.description}</CardDescription>
              </CardHeader>
              <CardContent>
                {active.items.length === 0 ? (
                  <p className="text-sm text-fg-muted">This folder is empty.</p>
                ) : (
                  <DataTable
                    caption={`${active.label} files`}
                    rows={active.items}
                    rowKey={(e) => e.file.id}
                    rowLabel={(e) => e.file.originalName}
                    columns={[
                      {
                        key: 'name',
                        header: 'File',
                        cell: (e) => (
                          <span className="flex flex-col">
                            <span className="font-medium break-all">{e.file.originalName}</span>
                            {e.entityLabel ? (
                              e.entityHref ? (
                                <Link
                                  href={e.entityHref}
                                  className="text-xs text-primary underline"
                                >
                                  {e.entityLabel}
                                </Link>
                              ) : (
                                <span className="text-xs text-fg-muted">{e.entityLabel}</span>
                              )
                            ) : null}
                          </span>
                        ),
                      },
                      {
                        key: 'purpose',
                        header: 'Purpose',
                        cell: (e) => humanize(String(e.file.purpose)),
                        hideOnMobile: true,
                      },
                      {
                        key: 'size',
                        header: 'Size',
                        cell: (e) => formatBytes(e.file.sizeBytes),
                        hideOnMobile: true,
                      },
                      {
                        key: 'status',
                        header: 'Scan',
                        cell: (e) => (
                          <FileStatusBadge
                            fileId={e.file.id}
                            status={e.file.status}
                            reason={e.file.statusReason}
                          />
                        ),
                      },
                      {
                        key: 'added',
                        header: 'Added',
                        cell: (e) => formatDateLabel(e.file.createdAt, zone),
                      },
                      {
                        key: 'access',
                        header: 'Access',
                        mobileLabel: 'Access',
                        cell: (e) => (
                          <GrantsDisclosure
                            fileId={e.file.id}
                            ownedByMe={e.file.ownerUserId === identity.session?.user.id}
                          />
                        ),
                      },
                      {
                        key: 'download',
                        header: <span className="sr-only">Download</span>,
                        mobileLabel: 'Download',
                        cell: (e) => (
                          <SignedDownloadButton
                            fileId={e.file.id}
                            fileName={e.file.originalName}
                            status={e.file.status}
                          />
                        ),
                      },
                    ]}
                  />
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Released reports</CardTitle>
          <CardDescription>
            Only reports a named reviewer released appear here.{' '}
            <Link href="/portal/reports" className="underline">
              See all reports
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reports.length === 0 ? (
            <p className="text-sm text-fg-muted">No released reports yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {reports.slice(0, 5).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/portal/reports/${r.id}`}
                    className="font-medium text-primary underline"
                  >
                    {r.title}
                  </Link>
                  <span className="text-fg-muted">
                    {humanize(r.kind)} · v{r.releasedVersion ?? '—'} ·{' '}
                    {r.releasedAt ? formatDateLabel(r.releasedAt, zone) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
