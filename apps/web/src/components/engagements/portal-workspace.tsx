import Link from 'next/link';
import type { EngagementItemDto, EngagementWorkspaceDto } from '@simplexd/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { LinkButton } from '@/components/portal/link-button';
import { CustomerItemActions } from './customer-item-actions';
import {
  ItemEvidenceList,
  ItemHeading,
  ItemMeta,
  ItemResponses,
  SEVERITY_LABELS,
  groupItems,
} from './item-view';

/**
 * Customer view of an engagement's records: what needs their input, the red
 * flags with severity, the checklist, survey references and findings the
 * team chose to share, released reports and linked appointments (with the
 * live meeting link while a virtual inspection's conference is ready).
 * Internal staff records never reach this component: the server filters.
 */

export function workspaceLabel(workflowTemplateKey: string): string {
  switch (workflowTemplateKey) {
    case 'due_diligence':
      return 'Due diligence';
    case 'virtual_inspection':
      return 'Inspection';
    case 'purchase_support':
      return 'Closing';
    default:
      return 'Checklist';
  }
}

function ItemCard({
  item,
  zone,
  serviceRequestId,
}: {
  item: EngagementItemDto;
  zone: string;
  serviceRequestId: string;
}) {
  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <ItemHeading item={item} />
      <ItemMeta item={item} zone={zone} />
      <ItemResponses item={item} zone={zone} />
      <ItemEvidenceList item={item} mode="signed" zone={zone} />
      <CustomerItemActions item={item} serviceRequestId={serviceRequestId} />
    </li>
  );
}

export function PortalWorkspace({
  workspace,
  zone,
}: {
  workspace: EngagementWorkspaceDto;
  zone: string;
}) {
  const { items, summary } = workspace;
  const waiting = items.filter((i) => i.can.respond || i.can.attachEvidence);
  const groups = groupItems(items);
  const label = workspaceLabel(workspace.workflowTemplateKey);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Open red flags"
          value={summary.redFlags.open}
          hint={
            summary.redFlags.highestOpenSeverity
              ? `Highest: ${SEVERITY_LABELS[summary.redFlags.highestOpenSeverity] ?? summary.redFlags.highestOpenSeverity}`
              : summary.redFlags.total > 0
                ? 'All cleared'
                : 'None recorded'
          }
          tone={summary.redFlags.open > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label="Queries for you"
          value={summary.openCustomerQueries}
          tone={summary.openCustomerQueries > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Documents requested"
          value={summary.openDocumentRequests}
          tone={summary.openDocumentRequests > 0 ? 'warning' : 'neutral'}
        />
        <Stat label="Records closed" value={`${summary.resolved} / ${summary.total}`} />
      </div>

      {waiting.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting on you</CardTitle>
            <CardDescription>
              Answer the team&apos;s queries and upload the documents they asked for. Each answer
              is recorded with your name and time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {waiting.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  zone={zone}
                  serviceRequestId={workspace.serviceRequestId}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState
          title={`No ${label.toLowerCase()} records yet`}
          description="The team adds the document checklist, survey references, findings, queries and red flags as the engagement progresses. You are notified when something needs your answer."
        />
      ) : (
        groups.map((group) => (
          <Card key={group.kind}>
            <CardHeader>
              <CardTitle>
                {group.label}{' '}
                <Badge tone="neutral">
                  {group.items.filter((i) => i.status === 'open' || i.status === 'in_progress').length}{' '}
                  open
                </Badge>
              </CardTitle>
              <CardDescription>{groupDescription(group.kind)}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {group.items
                  .filter((i) => !waiting.includes(i))
                  .map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      zone={zone}
                      serviceRequestId={workspace.serviceRequestId}
                    />
                  ))}
                {group.items.every((i) => waiting.includes(i)) ? (
                  <li className="text-sm text-fg-muted">All of these are listed above under “Waiting on you”.</li>
                ) : null}
              </ul>
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle>Reports</CardTitle>
          <CardDescription>
            Released reports only. A decision memorandum or inspection report is released after a
            named professional who is not its author has reviewed it; each release is a frozen
            version you can export.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {workspace.reports.length === 0 ? (
            <p className="text-sm text-fg-muted">No report has been released on this request yet.</p>
          ) : (
            <ul className="space-y-2">
              {workspace.reports.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                >
                  <span className="min-w-0">
                    <Link href={`/portal/reports/${r.id}`} className="font-medium text-primary underline">
                      {r.title}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {humanize(r.kind)} · version {r.releasedVersion ?? r.currentVersion}
                      {r.releasedAt ? ` · released ${formatDateTimeLabel(r.releasedAt, zone)}` : ''}
                      {r.namedReviewerName ? ` · reviewed by ${r.namedReviewerName}` : ''}
                    </span>
                  </span>
                  {r.releasedVersion ? (
                    <LinkButton
                      href={`/api/v1/reports/${r.id}/export`}
                      target="_blank"
                      rel="noopener"
                      variant="secondary"
                      size="sm"
                    >
                      Export (print / save as PDF)
                    </LinkButton>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {workspace.appointments.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Appointments</CardTitle>
            <CardDescription>
              Live meeting links appear here once the video conference is ready and until the
              appointment ends.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {workspace.appointments.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                >
                  <span>
                    <Link href={`/portal/appointments/${a.id}`} className="font-medium underline">
                      {humanize(a.kind)} · {formatDateTimeLabel(a.startsAt, zone)}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {a.staffName ? `With ${a.staffName} · ` : ''}
                      {humanize(a.meetingProvider)}
                      {a.conferenceStatus === 'pending' ? ' · meeting link being created' : ''}
                      {a.conferenceStatus === 'failed'
                        ? ' · meeting link could not be created; the team will send one'
                        : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={a.status} />
                    {a.meetingUrl ? (
                      <LinkButton href={a.meetingUrl} target="_blank" rel="noopener noreferrer" size="sm">
                        Join live meeting
                      </LinkButton>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function groupDescription(kind: EngagementItemDto['kind']): string {
  switch (kind) {
    case 'red_flag':
      return 'Issues that affect the decision, with the severity the reviewer assigned. Severity is a professional judgement within the stated scope, not a legal guarantee.';
    case 'query':
      return 'Questions from the team. Answered queries stay here with your reply.';
    case 'document_check':
      return 'Documents the team checks against the registry and the seller. Upload what is requested; the team records the outcome.';
    case 'survey_reference':
      return 'Survey plan and beacon references verified by the surveyor.';
    case 'site_finding':
      return 'What was observed on site or on camera, with severity.';
    case 'closing_task':
      return 'Steps to completion tracked by your representative.';
    case 'handover_document':
      return 'Documents to be handed over at completion.';
    case 'condition':
      return 'Conditions attached to the offer or agreement.';
    case 'lease_milestone':
      return 'Milestones agreed for the lease.';
  }
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  const ring =
    tone === 'danger'
      ? 'border-danger/40'
      : tone === 'warning'
        ? 'border-warning/40'
        : 'border-border';
  return (
    <div className={`rounded-md border ${ring} bg-bg-elevated p-3`}>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}
