import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PREFERRED_TIMELINE_LABELS } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  formatWholeNaira,
  humanize,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { getStaffRequestView } from '@/lib/admin/server/service-requests';
import { listInvitablePartners } from '@/lib/admin/server/partners';
import { priorityLabel } from '@/lib/admin/sla';
import { AssignmentsPanel } from '@/components/admin/assignments-panel';
import { EntityFiles } from '@/components/admin/entity-files';
import { Money } from '@/components/admin/money';
import { NotesPanel } from '@/components/admin/notes-panel';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../_components/bits';
import { QuotesPanel } from './_components/quotes-panel';
import { TransitionsPanel } from './_components/transitions-panel';
import { TriagePanel } from './_components/triage-panel';

export const metadata: Metadata = { title: 'Service request' };
export const dynamic = 'force-dynamic';

const SLA_TONE = {
  none: 'neutral',
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
  stopped: 'neutral',
} as const;

export default async function ServiceRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const identity = await requireStaffPage('service_requests.read_all');
  const { id } = await params;
  let view;
  try {
    view = await getStaffRequestView(identity, id);
  } catch {
    notFound();
  }
  const { request: r, permissions } = view;
  const partners = await listInvitablePartners(identity).catch(() => []);
  const assignees = [
    ...view.staff.map((s) => ({
      userId: s.userId,
      name: s.name,
      kind: 'staff' as const,
      detail: s.roles.map(humanize).join(', '),
    })),
    ...partners.map((p) => ({
      userId: p.userId,
      name: p.name,
      kind: 'partner' as const,
      detail: `${humanize(p.partnerType)} · ${humanize(p.verificationStatus)}`,
    })),
  ];
  const canCreateProject =
    permissions.projects &&
    !view.project &&
    ['accepted', 'awaiting_payment', 'in_progress'].includes(r.status);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/service-requests" className="underline">
            Service requests
          </Link>
        }
        title={`${r.reference} · ${r.title}`}
        description={`${r.serviceName}${r.marketName ? ` · ${r.marketName}` : ''} · ${view.organization.name}`}
        actions={
          <>
            <StatusBadge status={r.status} />
            <Badge tone={SLA_TONE[view.sla.state]}>{view.sla.label}</Badge>
            <Badge tone={r.priority <= 2 ? 'danger' : 'neutral'}>{priorityLabel(r.priority)}</Badge>
          </>
        }
      />

      {view.sla.state === 'overdue' ? (
        <Alert tone="danger" title="This request is past its SLA">
          Due {formatDateTimeLabel(view.slaDueAt!)}. Escalate by reassigning, pausing with a reason,
          or updating the customer.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section title="Request">
            <DefinitionList
              items={[
                {
                  term: 'Organisation',
                  value: (
                    <Link href={`/admin/customers/${view.organization.id}`} className="underline">
                      {view.organization.name}
                    </Link>
                  ),
                },
                {
                  term: 'Requested by',
                  value: view.requestedBy
                    ? `${view.requestedBy.name} (${view.requestedBy.email})`
                    : null,
                },
                { term: 'Budget', value: r.budgetNaira ? formatWholeNaira(r.budgetNaira) : null },
                {
                  term: 'Preferred timeline',
                  value: r.preferredTimeline
                    ? PREFERRED_TIMELINE_LABELS[r.preferredTimeline]
                    : null,
                },
                { term: 'Project manager', value: r.assignedPm?.name ?? null },
                {
                  term: 'SLA due',
                  value: view.slaDueAt ? formatDateTimeLabel(view.slaDueAt) : null,
                },
                { term: 'Received', value: formatDateTimeLabel(r.createdAt) },
                {
                  term: 'Lead',
                  value: view.lead ? (
                    <Link href={`/admin/leads/${view.lead.id}`} className="underline">
                      {view.lead.contactName} ({humanize(view.lead.status)})
                    </Link>
                  ) : null,
                },
                {
                  term: 'Project',
                  value: view.project ? (
                    <Link href={`/admin/projects/${view.project.id}`} className="underline">
                      {view.project.name} ({humanize(view.project.status)})
                    </Link>
                  ) : null,
                },
                {
                  term: 'Property',
                  value: view.propertyId ? (
                    <Link href={`/admin/properties/${view.propertyId}`} className="underline">
                      Open property
                    </Link>
                  ) : null,
                },
                {
                  term: 'Scenario',
                  value: r.scenarioId ? (
                    <Link href={`/portal/scenarios`} className="underline">
                      Saved scenario linked
                    </Link>
                  ) : null,
                },
              ]}
            />
            {r.description ? (
              <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">{r.description}</p>
            ) : null}
            {Object.keys(r.intake).length > 0 ? (
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer font-medium">
                  Intake answers ({Object.keys(r.intake).length})
                </summary>
                <DefinitionList
                  className="mt-2"
                  items={Object.entries(r.intake).map(([k, v]) => ({
                    term: humanize(k),
                    value: v,
                  }))}
                />
              </details>
            ) : null}
            {r.pauseReason || r.cancelReason || r.rejectReason ? (
              <Alert tone="warning" title="Recorded reason">
                {r.pauseReason ?? r.cancelReason ?? r.rejectReason}
              </Alert>
            ) : null}
            {canCreateProject ? (
              <Link
                href={`/admin/projects?create=1&serviceRequestId=${r.id}&organizationId=${view.organization.id}&name=${encodeURIComponent(r.title)}`}
              >
                <Button size="sm">Create project from this request</Button>
              </Link>
            ) : null}
          </Section>

          <Section
            title="Quotations"
            description="Versioned quotes; issuing moves the request to quoted and starts the customer's acceptance window."
          >
            <QuotesPanel
              requestId={r.id}
              status={r.status}
              quotes={view.quotes}
              templates={view.templates}
              taxTreatments={view.taxTreatments}
              canQuote={permissions.quote}
            />
          </Section>

          <Section
            title="Documents"
            description="Files attached to this request. Download links are short-lived and only offered for scanned, clean files."
          >
            <EntityFiles identity={identity} entityType="service_request" entityId={r.id} />
          </Section>

          <Section
            title="Notes"
            description="Internal notes stay with staff; customer notes appear on the customer's request page."
          >
            <NotesPanel entityType="service_request" entityId={r.id} notes={r.notes} canWrite />
          </Section>

          <Section title="Timeline">
            <ol className="space-y-2">
              {r.transitions.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-baseline gap-2 border-l-2 border-border pl-3"
                >
                  <span className="text-xs text-fg-muted">{formatDateTimeLabel(t.createdAt)}</span>
                  <span>
                    {t.fromStatus ? `${humanize(t.fromStatus)} → ` : ''}
                    <strong>{humanize(t.toStatus)}</strong>
                  </span>
                  <span className="text-xs text-fg-muted">
                    by {t.actorName ?? t.actorType}
                    {t.reason ? ` · ${t.reason}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Triage and assignment">
            <TriagePanel
              request={{
                id: r.id,
                status: r.status,
                version: r.version,
                priority: r.priority,
                assignedPmUserId: r.assignedPm?.id ?? null,
                slaDueAt: view.slaDueAt,
              }}
              staff={view.staff}
              permissions={permissions}
            />
          </Section>

          <Section
            title="Transitions"
            description="Every move records who, when and why; billing consequences are recorded with the transition."
          >
            <TransitionsPanel
              requestId={r.id}
              version={r.version}
              transitions={view.staffTransitions}
              permissions={permissions}
            />
          </Section>

          <Section
            title="Assignments"
            description="Inspectors, surveyors and partners on this request."
          >
            <AssignmentsPanel
              target={{ serviceRequestId: r.id }}
              assignments={view.assignments}
              assignees={assignees}
              canAssign={permissions.assign}
            />
          </Section>

          {permissions.finance ? (
            <Section
              title="Invoices"
              actions={
                <Link
                  href={`/admin/finance/invoices?serviceRequestId=${r.id}`}
                  className="text-sm underline"
                >
                  All
                </Link>
              }
            >
              {view.invoices.length === 0 ? (
                <p className="text-fg-muted">
                  No invoices yet. Accepting an issued quote creates the deposit or service invoice.
                </p>
              ) : (
                <ul className="space-y-1">
                  {view.invoices.map((inv) => (
                    <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/admin/finance/invoices/${inv.id}`} className="underline">
                        {inv.number}
                      </Link>
                      <span className="flex items-center gap-2">
                        <Money kobo={inv.totalKobo} currency={inv.currency} />
                        <StatusBadge status={inv.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          <Section
            title="Appointments and visits"
            actions={
              <Link
                href={`/admin/appointments/book?serviceRequestId=${r.id}&customer=${encodeURIComponent(view.requestedBy ? `${view.requestedBy.name} (${view.organization.name})` : view.organization.name)}`}
                className="text-sm underline"
              >
                Book appointment
              </Link>
            }
          >
            {view.appointments.length === 0 && view.siteVisits.length === 0 ? (
              <p className="text-fg-muted">Nothing scheduled.</p>
            ) : (
              <ul className="space-y-1">
                {view.appointments.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {humanize(a.kind)} · {formatDateTimeLabel(a.startsAt)}
                      {a.staffName ? ` · ${a.staffName}` : ''}
                    </span>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
                {view.siteVisits.map((v) => (
                  <li key={v.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      Site visit ·{' '}
                      {v.scheduledAt ? formatDateTimeLabel(v.scheduledAt) : 'unscheduled'}
                      {v.inspectorName ? ` · ${v.inspectorName}` : ''}
                      {v.projectId ? (
                        <>
                          {' '}
                          <Link
                            href={`/admin/projects/${v.projectId}?tab=visits`}
                            className="underline"
                          >
                            project
                          </Link>
                        </>
                      ) : null}
                    </span>
                    <StatusBadge status={v.status} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
