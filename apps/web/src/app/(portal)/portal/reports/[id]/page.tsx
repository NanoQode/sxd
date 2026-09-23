import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema, type FileDto } from '@simplexd/contracts';
import { PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { ReportView } from '@/components/portal/report-view';
import { getFile } from '@/server/files/queries';
import { getReport, listReportEvidence } from '@/server/projects/reports';

export const metadata: Metadata = { title: 'Report' };
export const dynamic = 'force-dynamic';

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/reports/${id}`);
  const report = await getReport(identity, id).catch((err) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) return null;
    throw err;
  });
  if (!report || report.status !== 'released') notFound();
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const released = report.revisions.find((r) => r.version === report.releasedVersion) ?? report.revisions[0];
  const [evidence, attachments] = await Promise.all([
    listReportEvidence(identity, id).catch(() => ({ items: [] })),
    Promise.all(
      (released?.attachmentFileIds ?? []).map((fileId) => getFile(identity, fileId).catch(() => null)),
    ).then((files) => files.filter((f): f is FileDto => f !== null)),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/reports" className="underline">
            Reports
          </Link>
        }
        title={report.title}
        description="The released revision. Earlier revisions and the review trail stay with the team; a re-release creates a new version."
      />
      <ReportView
        report={report}
        attachments={attachments}
        evidence={evidence.items}
        zone={zone}
        projectHref={report.projectId ? `/portal/projects/${report.projectId}?tab=reports` : report.serviceRequestId ? `/portal/requests/${report.serviceRequestId}` : null}
      />
    </div>
  );
}
