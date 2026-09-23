import Link from 'next/link';
import type { EvidenceDto, FileDto, ReportDetailDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { renderMarkdown } from '@/lib/markdown';
import { formatBytes } from '@/lib/portal/format';
import { EvidenceGallery } from './evidence-gallery';
import { LinkButton } from './link-button';
import { SignedDownloadButton } from './signed-download';

/**
 * Released report: the released revision only (drafts and reviews are never
 * sent to customers), the reviewer's name, scope limitations, attachments
 * through signed downloads and the evidence it references.
 */
export function ReportView({
  report,
  attachments,
  evidence,
  zone,
  projectHref,
}: {
  report: ReportDetailDto;
  attachments: FileDto[];
  evidence: EvidenceDto[];
  zone: string;
  projectHref: string | null;
}) {
  const released =
    report.revisions.find((r) => r.version === report.releasedVersion) ??
    report.revisions[0] ??
    null;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {report.title}
            <Badge tone="info">{humanize(report.kind)}</Badge>
            <Badge tone="success">
              Released v{report.releasedVersion ?? report.currentVersion}
            </Badge>
          </CardTitle>
          <CardDescription>
            {report.releasedAt
              ? `Released ${formatDateTimeLabel(report.releasedAt, zone)}`
              : 'Release date not recorded'}
            {report.authorName ? ` · author ${report.authorName}` : ''}
            {report.namedReviewerName ? ` · reviewed by ${report.namedReviewerName}` : ''}
            {projectHref ? (
              <>
                {' · '}
                <Link href={projectHref} className="underline">
                  {report.projectId ? 'Open project' : 'Open request'}
                </Link>
              </>
            ) : null}
          </CardDescription>
          </div>
          {report.releasedVersion ? (
            <LinkButton
              href={`/api/v1/reports/${report.id}/export`}
              target="_blank"
              rel="noopener"
              variant="secondary"
              size="sm"
              className="shrink-0"
            >
              Export (print / save as PDF)
            </LinkButton>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {!released ? (
            <Alert tone="warning" title="Released revision not available">
              The report is marked released but its revision could not be loaded; quote the report
              id to support.
            </Alert>
          ) : (
            <>
              {released.summary ? <p className="text-sm font-medium">{released.summary}</p> : null}
              {released.scopeLimitations ? (
                <Alert tone="info" title="Scope limitations">
                  <p className="whitespace-pre-wrap">{released.scopeLimitations}</p>
                </Alert>
              ) : null}
              <div
                className="sx-prose max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(released.bodyMarkdown) }}
              />
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Attachments</CardTitle>
          <CardDescription>
            Downloads use time-limited signed links; every download is logged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attachments.length === 0 ? (
            <p className="text-sm text-fg-muted">This revision has no attachments.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {attachments.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                >
                  <span>
                    <span className="font-medium break-all">{f.originalName}</span>
                    <span className="text-fg-muted"> · {formatBytes(f.sizeBytes)}</span>
                  </span>
                  <SignedDownloadButton fileId={f.id} fileName={f.originalName} status={f.status} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Evidence referenced</CardTitle>
          <CardDescription>
            Approved photos, video and documents this report relies on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EvidenceGallery items={evidence} zone={zone} />
        </CardContent>
      </Card>
    </div>
  );
}
