import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, PREFERRED_TIMELINE_LABELS, uuidSchema } from '@simplexd/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  formatWholeNaira,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { getServiceRequestDetail } from '@/server/requests/queries';
import { intakeLabel } from '@/server/requests/services';
import { RequestActions } from './request-actions';

export const metadata: Metadata = { title: 'Request' };
export const dynamic = 'force-dynamic';

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/requests/${id}`);
  const detail = await getServiceRequestDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!detail) notFound();
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const intakeEntries = Object.entries(detail.intake);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/requests" className="underline">
            Requests
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-lg text-fg-muted">{detail.reference}</span>
            <span>{detail.title}</span>
          </span>
        }
        description={`${detail.serviceName}${detail.marketName ? ` · ${detail.marketName}` : ''}`}
        actions={<StatusBadge status={detail.status} />}
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Request details</CardTitle>
              <CardDescription>What you told us at intake. Triage may ask follow-up questions in the notes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="whitespace-pre-wrap">{detail.description ?? '—'}</p>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <div>
                  <dt className="text-fg-muted">Budget</dt>
                  <dd>{detail.budgetNaira !== null ? formatWholeNaira(detail.budgetNaira) : 'Not specified'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Preferred timeline</dt>
                  <dd>{detail.preferredTimeline ? PREFERRED_TIMELINE_LABELS[detail.preferredTimeline] : 'Not specified'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Scenario</dt>
                  <dd>
                    {detail.scenarioId ? (
                      <Link href={`/explore?scenario=${detail.scenarioId}`} className="text-primary underline">
                        Open linked scenario
                      </Link>
                    ) : (
                      'None linked'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Assigned contact</dt>
                  <dd>{detail.assignedPm?.name ?? 'Assigned at triage'}</dd>
                </div>
              </dl>
              {intakeEntries.length > 0 ? (
                <div>
                  <h3 className="mb-2 font-medium">Intake answers</h3>
                  <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    {intakeEntries.map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-fg-muted">{intakeLabel(key).label}</dt>
                        <dd className="whitespace-pre-wrap">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
              {detail.cancelReason ? (
                <p className="rounded-md bg-bg-sunken p-3">
                  <strong>Cancellation reason:</strong> {detail.cancelReason}
                </p>
              ) : null}
              {detail.pauseReason ? (
                <p className="rounded-md bg-bg-sunken p-3">
                  <strong>Paused:</strong> {detail.pauseReason}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
              <CardDescription>Messages between you and the team on this request. Internal staff notes are never shown here.</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.notes.length === 0 ? (
                <p className="text-sm text-fg-muted">No notes yet. Add one below to give the team more context.</p>
              ) : (
                <ol className="space-y-3">
                  {detail.notes.map((n) => (
                    <li key={n.id} className="rounded-md border border-border p-3 text-sm">
                      <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                        <span className="font-medium text-fg">{n.authorName ?? 'Team'}</span>
                        <span>{formatDateTimeLabel(n.createdAt, zone)}</span>
                        <Badge tone="neutral">{humanize(n.visibility)}</Badge>
                      </p>
                      <p className="whitespace-pre-wrap">{n.body}</p>
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-4">
                <RequestActions
                  id={detail.id}
                  version={detail.version}
                  status={detail.status}
                  availableTransitions={detail.availableTransitions}
                  mode="note"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Status timeline</CardTitle>
              <CardDescription>Every transition is recorded with who made it and why.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 border-l border-border pl-4">
                {detail.transitions.map((t) => (
                  <li key={t.id} className="relative text-sm">
                    <span aria-hidden="true" className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                    <p className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={t.toStatus} />
                      <span className="text-xs text-fg-muted">{formatDateTimeLabel(t.createdAt, zone)}</span>
                    </p>
                    <p className="text-xs text-fg-muted">
                      {t.actorName ?? humanize(t.actorType)}
                      {t.fromStatus ? ` · from ${humanize(t.fromStatus)}` : ' · created'}
                    </p>
                    {t.reason ? <p className="mt-1 text-fg-muted">Reason: {t.reason}</p> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
              <CardDescription>
                {detail.availableTransitions.length === 0
                  ? `No customer action is available while the request is ${humanize(detail.status).toLowerCase()}.`
                  : 'Cancelling or pausing needs a reason and is recorded in the timeline.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RequestActions
                id={detail.id}
                version={detail.version}
                status={detail.status}
                availableTransitions={detail.availableTransitions}
                mode="transitions"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
