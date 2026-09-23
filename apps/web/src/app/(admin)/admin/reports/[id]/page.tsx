import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { can, requireAnyStaff } from '@/lib/admin/server/context';
import { reportPeople } from '@/lib/admin/server/reports';
import { listStaffAssignees } from '@/server/leads/admin';
import { getReport, listReportEvidence } from '@/server/projects/reports';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../_components/bits';

export const metadata: Metadata = { title: 'Report review' };
export const dynamic = 'force-dynamic';

export default async function ReportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/reports');
  requireAnyStaff(identity, ['reports.review', 'reports.draft', 'reports.release']);
  const { id } = await params;
  let report;
  try {
    report = await getReport(identity, id);
  } catch {
    notFound();
  }
  const me = identity.session!.user.id;
  const [staff, people, evidence] = await Promise.all([
    listStaffAssignees(identity),
    reportPeople(identity, [report.createdBy, report.namedReviewerUserId, report.releasedBy, ...report.revisions.map((r) => r.reviewerUserId), ...report.revisions.map((r) => r.createdBy)]),
    listReportEvidence(identity, id).then((r) => ('items' in r ? r.items : [])).catch(() => []),
  ]);
  const isAuthor = report.createdBy === me;
  const isReviewer = report.namedReviewerUserId === me;
  const canDraft = can(identity, 'reports.draft');
  const canReview = can(identity, 'reports.review');
  const canRelease = can(identity, 'reports.release');
  const current = report.revisions.find((r) => r.version === report.currentVersion) ?? report.revisions[report.revisions.length - 1];
  const reviewers = staff.filter((s) => s.userId !== report.createdBy && s.roles.some((r) => ['project_manager', 'operations_manager', 'super_admin', 'inspector'].includes(r)));
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/reports" className="underline">
            Reports
          </Link>
        }
        title={report.title}
        description={`${humanize(report.kind)} · v${report.currentVersion}${report.releasedVersion ? ` · released v${report.releasedVersion}` : ''}`}
        actions={
          <>
            <StatusBadge status={report.status === 'released' ? 'delivered' : report.status === 'approved' ? 'accepted' : report.status === 'changes_requested' ? 'paused' : report.status} label={humanize(report.status)} />
            {report.customerVisible ? <Badge tone="success">customer can see released version</Badge> : <Badge tone="neutral">not visible to customer</Badge>}
          </>
        }
      />
      {isAuthor && ['in_review', 'approved'].includes(report.status) ? (
        <Alert tone="info" title="You are the author">
          Review and release must be done by another staff member; the server enforces this.
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section title={`Revision ${current?.version ?? '—'}`} description={current ? `Created ${formatDateTimeLabel(current.createdAt)} by ${people[current.createdBy ?? ''] ?? 'unknown'}` : undefined}>
            {current ? (
              <>
                {current.summary ? <p className="font-medium">{current.summary}</p> : null}
                <article className="prose prose-sm max-w-none whitespace-pre-wrap rounded-md bg-bg-sunken p-3 dark:prose-invert">{current.bodyMarkdown}</article>
                {current.scopeLimitations ? (
                  <Alert tone="warning" title="Scope and limitations">
                    {current.scopeLimitations}
                  </Alert>
                ) : null}
                {current.attachmentFileIds.length > 0 ? (
                  <p className="text-xs">
                    Attachments:{' '}
                    {current.attachmentFileIds.map((f) => (
                      <a key={f} href={`/api/v1/files/${f}/download`} className="mr-2 underline">
                        {f.slice(0, 8)}
                      </a>
                    ))}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-fg-muted">No revision content yet.</p>
            )}
          </Section>
          <Section title={`Revision history (${report.revisions.length})`}>
            <ol className="space-y-2">
              {[...report.revisions].reverse().map((r) => (
                <li key={r.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      v{r.version} <span className="text-xs text-fg-muted">{formatDateTimeLabel(r.createdAt)} · {people[r.createdBy ?? ''] ?? 'unknown'}</span>
                    </span>
                    <StatusBadge status={r.state === 'released' ? 'delivered' : r.state === 'approved' ? 'accepted' : r.state === 'changes_requested' ? 'paused' : r.state} label={humanize(r.state)} />
                  </div>
                  {r.reviewDecision ? (
                    <p className="mt-1 text-xs text-fg-muted">
                      Review: {humanize(r.reviewDecision)} by {people[r.reviewerUserId ?? ''] ?? 'unknown'} {r.reviewedAt ? formatDateTimeLabel(r.reviewedAt) : ''}
                      {r.reviewNote ? ` · ${r.reviewNote}` : ''}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </Section>
          {evidence.length > 0 ? (
            <Section title={`Referenced evidence (${evidence.length})`}>
              <ul className="space-y-1 text-sm">
                {evidence.map((e) => (
                  <li key={e.id}>
                    <a href={`/api/v1/files/${e.fileId}/download`} className="underline">
                      {e.file?.originalName ?? e.fileId.slice(0, 8)}
                    </a>{' '}
                    <span className="text-xs text-fg-muted">{humanize(e.kind)} · {humanize(e.publication)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
        <div className="space-y-6">
          <Section title="People">
            <DefinitionList
              items={[
                { term: 'Author', value: report.authorName ?? people[report.createdBy ?? ''] ?? null },
                { term: 'Named reviewer', value: report.namedReviewerName ?? (report.namedReviewerUserId ? people[report.namedReviewerUserId] : null) },
                { term: 'Released by', value: report.releasedBy ? `${people[report.releasedBy] ?? 'unknown'} · ${report.releasedAt ? formatDateTimeLabel(report.releasedAt) : ''}` : null },
                { term: 'Project', value: report.projectId ? <Link href={`/admin/projects/${report.projectId}?tab=reports`} className="underline">Open project</Link> : null },
              ]}
            />
          </Section>
          <Section title="Workflow" description="Available transitions depend on the status and on who you are.">
            <div className="flex flex-col gap-2">
              {canDraft && ['draft', 'changes_requested', 'approved', 'released'].includes(report.status) ? (
                <FormDialog
                  trigger={report.status === 'released' ? 'New revision (released stays frozen)' : 'Add revision'}
                  title="Add a revision"
                  description="Creates the next version; the report returns to draft."
                  path={`/api/v1/reports/${report.id}/revisions`}
                  successMessage="Revision added"
                  fields={[
                    { name: 'summary', label: 'Summary', type: 'textarea', defaultValue: current?.summary ?? '' },
                    { name: 'bodyMarkdown', label: 'Body (markdown)', type: 'textarea', required: true, defaultValue: current?.bodyMarkdown ?? '' },
                    { name: 'scopeLimitations', label: 'Scope and limitations', type: 'textarea', defaultValue: current?.scopeLimitations ?? '' },
                  ]}
                  toBody={(v) => ({ summary: v.summary || null, bodyMarkdown: v.bodyMarkdown, scopeLimitations: v.scopeLimitations || null, attachmentFileIds: current?.attachmentFileIds ?? [], expectedVersion: report.version })}
                />
              ) : null}
              {canDraft && ['draft', 'changes_requested'].includes(report.status) ? (
                <FormDialog
                  trigger="Submit for review"
                  title="Submit for review"
                  description="Name a professional reviewer who is not the author."
                  path={`/api/v1/reports/${report.id}/submit`}
                  successMessage="Submitted for review"
                  variant="primary"
                  fields={[{ name: 'namedReviewerUserId', label: 'Named reviewer', type: 'select', required: true, options: reviewers.map((s) => ({ value: s.userId, label: `${s.name} (${s.roles.map(humanize).join(', ')})` })) }]}
                  toBody={(v) => ({ namedReviewerUserId: v.namedReviewerUserId, expectedVersion: report.version })}
                />
              ) : null}
              {report.status === 'in_review' && canReview && !isAuthor ? (
                <>
                  <ApiAction path={`/api/v1/reports/${report.id}/review`} label="Approve" variant="primary" body={{ decision: 'approved', expectedVersion: report.version }} reasonKey="note" confirm={{ title: 'Approve this revision?', description: isReviewer ? 'You are the named reviewer.' : 'You are not the named reviewer; the server may refuse unless your role permits it.', confirmLabel: 'Approve' }} successMessage="Report approved" />
                  <ApiAction path={`/api/v1/reports/${report.id}/review`} label="Request changes" body={{ decision: 'changes_requested', expectedVersion: report.version }} reasonKey="note" confirm={{ title: 'Request changes?', requireReason: true, reasonLabel: 'What must change (sent to the author)', confirmLabel: 'Request changes' }} successMessage="Changes requested" />
                </>
              ) : null}
              {report.status === 'in_review' && (!canReview || isAuthor) ? <p className="text-xs text-fg-muted">{isAuthor ? 'Authors cannot review their own report.' : 'Reviewing needs reports.review.'}</p> : null}
              {report.status === 'approved' && canRelease && !isAuthor ? (
                <ApiAction path={`/api/v1/reports/${report.id}/release`} label="Release to customer" variant="primary" body={{ expectedVersion: report.version }} reasonKey="note" confirm={{ title: 'Release this report?', description: 'The approved revision becomes visible to the customer and is frozen.', confirmLabel: 'Release' }} successMessage="Report released" />
              ) : null}
              {report.status === 'approved' && (!canRelease || isAuthor) ? <p className="text-xs text-fg-muted">{isAuthor ? 'Authors cannot release their own report.' : 'Releasing needs reports.release.'}</p> : null}
              {report.availableTransitions.length === 0 ? <p className="text-xs text-fg-muted">No transitions from {humanize(report.status)}.</p> : null}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
