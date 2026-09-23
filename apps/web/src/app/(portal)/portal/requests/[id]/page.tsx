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
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatDateTimeLabel,
  formatWholeNaira,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { documentStage } from '@/lib/services/document-requirements';
import { koboToNaira } from '@/lib/portal/format';
import { listRequestAppointments } from '@/lib/portal/server/appointments';
import { loadInvoicesForRequest, loadQuotesForRequest } from '@/lib/portal/server/finance';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { DocumentsWeNeed } from '@/components/portal/documents-we-need';
import { FilesPanel } from '@/components/portal/files-panel';
import { LinkButton } from '@/components/portal/link-button';
import { NotesPanel } from '@/components/portal/notes-panel';
import { QuoteCard } from '@/components/portal/quote-panel';
import { SectionTabs, resolveTab } from '@/components/portal/section-tabs';
import { StartConversation } from '@/components/portal/start-conversation';
import { PortalWorkspace, workspaceLabel } from '@/components/engagements/portal-workspace';
import { listAssignments } from '@/server/assignments/service';
import { listConversations } from '@/server/conversations/service';
import { requirementsForCustomer } from '@/server/admin/configuration/document-requirements';
import { getEngagementWorkspace } from '@/server/engagements/workspace';
import { listFilesForEntity } from '@/server/files/queries';
import { getServiceRequestDetail } from '@/server/requests/queries';
import { intakeLabel } from '@/server/requests/services';
import { RequestActions } from './request-actions';

export const metadata: Metadata = { title: 'Request' };
export const dynamic = 'force-dynamic';

const TABS = [
  'overview',
  'workspace',
  'quotes',
  'invoices',
  'team',
  'documents',
  'appointments',
] as const;

export default async function RequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/requests/${id}`);
  const detail = await getServiceRequestDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!detail) notFound();
  const tab = resolveTab(tabParam, TABS);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity);
  const intakeEntries = Object.entries(detail.intake);
  const basePath = `/portal/requests/${id}`;

  const [quotes, invoices, workspace] = await Promise.all([
    tab === 'quotes' || tab === 'overview'
      ? loadQuotesForRequest(identity, id)
      : Promise.resolve([]),
    tab === 'invoices' || tab === 'overview'
      ? loadInvoicesForRequest(identity, id)
      : Promise.resolve([]),
    // The engagement workspace (checklist, findings, queries, red flags, released
    // reports) is loaded for its own tab and for the "waiting on you" counts.
    tab === 'workspace' || tab === 'overview'
      ? getEngagementWorkspace(identity, id).catch((err) => {
          if (err instanceof ApiError && err.code === 'forbidden') return null;
          throw err;
        })
      : Promise.resolve(null),
  ]);
  const workspaceTab = workspaceLabel(
    detail.serviceSlug.includes('inspection')
      ? 'virtual_inspection'
      : (workspace?.workflowTemplateKey ?? ''),
  );
  const awaitingCustomer = workspace
    ? workspace.summary.openCustomerQueries + workspace.summary.openDocumentRequests
    : 0;
  const closed = ['completed', 'cancelled', 'rejected'].includes(detail.status);
  const conversationId =
    tab === 'overview'
      ? ((
          await listConversations(identity, {
            status: 'all',
            entityType: 'service_request',
            entityId: id,
            limit: 1,
          })
        ).items[0]?.id ?? null)
      : null;
  const openQuotes = quotes.filter((q) => q.status === 'issued').length;
  const unpaid = invoices.filter((i) =>
    ['issued', 'partially_paid', 'overdue'].includes(i.status),
  ).length;

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
      <SectionTabs
        basePath={basePath}
        active={tab}
        label="Request sections"
        tabs={[
          { value: 'overview', label: 'Overview' },
          {
            value: 'workspace',
            label: workspaceTab,
            badge:
              awaitingCustomer > 0 ? (
                <Badge tone="warning">{awaitingCustomer} for you</Badge>
              ) : undefined,
          },
          {
            value: 'quotes',
            label: 'Quotes',
            badge:
              openQuotes > 0 ? <Badge tone="warning">{openQuotes} to decide</Badge> : undefined,
          },
          {
            value: 'invoices',
            label: 'Invoices',
            badge: unpaid > 0 ? <Badge tone="warning">{unpaid} due</Badge> : undefined,
          },
          { value: 'team', label: 'Team' },
          { value: 'documents', label: 'Documents' },
          { value: 'appointments', label: 'Appointments' },
        ]}
      />

      {tab === 'overview' ? (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Request details</CardTitle>
                <CardDescription>
                  What you told us at intake. Triage may ask follow-up questions in the notes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="whitespace-pre-wrap">{detail.description ?? '—'}</p>
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-fg-muted">Budget</dt>
                    <dd>
                      {detail.budgetNaira !== null
                        ? formatWholeNaira(detail.budgetNaira)
                        : 'Not specified'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Preferred timeline</dt>
                    <dd>
                      {detail.preferredTimeline
                        ? PREFERRED_TIMELINE_LABELS[detail.preferredTimeline]
                        : 'Not specified'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Scenario</dt>
                    <dd>
                      {detail.scenarioId ? (
                        <Link
                          href={`/explore?scenario=${detail.scenarioId}`}
                          className="text-primary underline"
                        >
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
                {detail.rejectReason ? (
                  <p className="rounded-md bg-bg-sunken p-3">
                    <strong>Declined:</strong> {detail.rejectReason}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {openQuotes > 0 || unpaid > 0 || awaitingCustomer > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Waiting on you</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-3">
                  {awaitingCustomer > 0 ? (
                    <LinkButton href={`${basePath}?tab=workspace`} variant="primary" size="sm">
                      {workspace!.summary.openCustomerQueries > 0
                        ? `Answer ${workspace!.summary.openCustomerQueries === 1 ? 'the query' : `${workspace!.summary.openCustomerQueries} queries`}`
                        : ''}
                      {workspace!.summary.openCustomerQueries > 0 &&
                      workspace!.summary.openDocumentRequests > 0
                        ? ' and '
                        : ''}
                      {workspace!.summary.openDocumentRequests > 0
                        ? `upload ${workspace!.summary.openDocumentRequests === 1 ? 'the requested document' : `${workspace!.summary.openDocumentRequests} requested documents`}`
                        : ''}
                    </LinkButton>
                  ) : null}
                  {openQuotes > 0 ? (
                    <LinkButton href={`${basePath}?tab=quotes`} variant="primary" size="sm">
                      Review {openQuotes === 1 ? 'the issued quote' : `${openQuotes} issued quotes`}
                    </LinkButton>
                  ) : null}
                  {unpaid > 0 ? (
                    <LinkButton href={`${basePath}?tab=invoices`} variant="secondary" size="sm">
                      Pay{' '}
                      {unpaid === 1 ? 'the outstanding invoice' : `${unpaid} outstanding invoices`}
                    </LinkButton>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
                <CardDescription>
                  Notes between you and the team on this request. Internal staff notes are never
                  shown here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <NotesPanel
                  entityType="service_request"
                  entityId={detail.id}
                  notes={detail.notes}
                  zone={zone}
                  readOnly={closed}
                  readOnlyReason="This request is closed; notes are read-only."
                />
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Engagement timeline</CardTitle>
                <CardDescription>
                  Every transition is recorded with who made it and why.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 border-l border-border pl-4">
                  {detail.transitions.map((t) => (
                    <li key={t.id} className="relative text-sm">
                      <span
                        aria-hidden="true"
                        className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary"
                      />
                      <p className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={t.toStatus} />
                        <span className="text-xs text-fg-muted">
                          {formatDateTimeLabel(t.createdAt, zone)}
                        </span>
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
                <CardTitle>Talk to your team</CardTitle>
                <CardDescription>
                  {detail.assignedPm
                    ? `${detail.assignedPm.name} manages this request.`
                    : 'A project manager is assigned at triage.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StartConversation
                  entityType="service_request"
                  entityId={detail.id}
                  subject={`${detail.reference}: ${detail.title}`}
                  contact={detail.assignedPm}
                  existingConversationId={conversationId}
                  canSend={caps.sendMessages && !closed}
                  cannotSendReason={
                    closed
                      ? 'This request is closed; open Messages for earlier conversations.'
                      : capabilityNote(caps, 'Sending messages')
                  }
                />
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
                />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'workspace' ? (
        <section aria-label={workspaceTab} className="space-y-4">
          {workspace ? (
            <PortalWorkspace workspace={workspace} zone={zone} />
          ) : (
            <EmptyState
              title="Engagement records are not available to your role"
              description="Viewing the checklist, findings and reports needs a member, adviser, approver or owner of this organisation."
            />
          )}
        </section>
      ) : null}

      {tab === 'quotes' ? (
        <section aria-label="Quotes" className="space-y-4">
          {quotes.length === 0 ? (
            <EmptyState
              title="No quote yet"
              description="The team issues a quotation after triage. You will be notified and can accept or reject it here with a recorded signature."
            />
          ) : (
            quotes.map((q) => (
              <QuoteCard
                key={q.id}
                quote={q}
                zone={zone}
                canAccept={caps.acceptQuotes}
                cannotAcceptReason={
                  caps.acceptQuotes ? undefined : capabilityNote(caps, 'Accepting a quote')
                }
                detailHref={`/portal/quotes/${q.id}`}
              />
            ))
          )}
        </section>
      ) : null}

      {tab === 'invoices' ? (
        <section aria-label="Invoices">
          {invoices.length === 0 ? (
            <EmptyState
              title="No invoices on this request"
              description="Invoices are raised when you accept a quotation that requires payment, and for milestones the team authorises."
            />
          ) : (
            <DataTable
              caption="Invoices on this request"
              rows={invoices}
              rowKey={(i) => i.id}
              rowLabel={(i) => `Invoice ${i.number}`}
              columns={[
                {
                  key: 'number',
                  header: 'Number',
                  cell: (i) => (
                    <Link
                      href={`/portal/invoices/${i.id}`}
                      className="font-mono text-primary underline"
                    >
                      {i.number}
                    </Link>
                  ),
                },
                { key: 'kind', header: 'Kind', cell: (i) => humanize(i.kind) },
                { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
                {
                  key: 'total',
                  header: 'Total',
                  cell: (i) => koboToNaira(i.totalKobo),
                  className: 'text-right',
                },
                {
                  key: 'balance',
                  header: 'Balance',
                  cell: (i) => koboToNaira(i.balanceKobo),
                  className: 'text-right',
                },
                {
                  key: 'due',
                  header: 'Due',
                  cell: (i) => (i.dueDate ? formatDateLabel(i.dueDate) : '—'),
                },
              ]}
            />
          )}
        </section>
      ) : null}

      {tab === 'team' ? (
        <TeamTab
          identity={identity}
          requestId={id}
          zone={zone}
          pmName={detail.assignedPm?.name ?? null}
        />
      ) : null}

      {tab === 'documents' ? (
        <>
          <DocumentsWeNeed
            requirements={await requirementsForCustomer(identity, detail.serviceId)}
            serviceId={detail.serviceId}
            stage={documentStage(detail.status, detail.transitions)}
          />
          <DocumentsTab
            identity={identity}
            requestId={id}
            zone={zone}
            canUpload={caps.uploadDocuments}
            closed={closed}
          />
        </>
      ) : null}

      {tab === 'appointments' ? (
        <AppointmentsTab identity={identity} requestId={id} zone={zone} />
      ) : null}
    </div>
  );
}

async function TeamTab({
  identity,
  requestId,
  zone,
  pmName,
}: {
  identity: Awaited<ReturnType<typeof requireSignedIn>>;
  requestId: string;
  zone: string;
  pmName: string | null;
}) {
  const page = await listAssignments(identity, { serviceRequestId: requestId, limit: 50 });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Assigned team</CardTitle>
        <CardDescription>
          {pmName
            ? `${pmName} is your project manager. `
            : 'A project manager is assigned at triage. '}
          Accepted and active assignments are listed; proposals still being confirmed are not.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {page.items.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No specialists are assigned yet beyond your project manager.
          </p>
        ) : (
          <DataTable
            caption="Assignments"
            rows={page.items}
            rowKey={(a) => a.id}
            rowLabel={(a) => a.assigneeName ?? a.assigneeUserId}
            columns={[
              {
                key: 'name',
                header: 'Name',
                cell: (a) => <span className="font-medium">{a.assigneeName ?? 'Team member'}</span>,
              },
              { key: 'role', header: 'Role', cell: (a) => humanize(a.role) },
              { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
              {
                key: 'since',
                header: 'Since',
                cell: (a) => formatDateLabel(a.startsAt ?? a.createdAt, zone),
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

async function DocumentsTab({
  identity,
  requestId,
  zone,
  canUpload,
  closed,
}: {
  identity: Awaited<ReturnType<typeof requireSignedIn>>;
  requestId: string;
  zone: string;
  canUpload: boolean;
  closed: boolean;
}) {
  const page = await listFilesForEntity(identity, {
    entityType: 'service_request',
    entityId: requestId,
    limit: 100,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        <CardDescription>
          Title papers, drawings and anything the team asked for. Files are scanned before anyone
          can open them; large files upload in parts and can resume.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FilesPanel
          files={page.items}
          entityType="service_request"
          entityId={requestId}
          purpose="org_document"
          zone={zone}
          canUpload={canUpload && !closed}
          cannotUploadReason={
            closed
              ? 'This request is closed; documents are read-only.'
              : 'Uploading documents needs an owner or member of this organisation.'
          }
        />
      </CardContent>
    </Card>
  );
}

async function AppointmentsTab({
  identity,
  requestId,
  zone,
}: {
  identity: Awaited<ReturnType<typeof requireSignedIn>>;
  requestId: string;
  zone: string;
}) {
  const items = await listRequestAppointments(identity, requestId);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Appointments linked to this request</CardTitle>
            <CardDescription>
              Consultations, viewings and site visits booked for this engagement.
            </CardDescription>
          </div>
          <LinkButton
            href={`/portal/appointments/new?request=${requestId}`}
            variant="secondary"
            size="sm"
          >
            Book an appointment
          </LinkButton>
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-fg-muted">No appointments are linked yet.</p>
        ) : (
          <DataTable
            caption="Linked appointments"
            rows={items}
            rowKey={(a) => a.id}
            rowLabel={(a) => `${humanize(a.kind)} ${formatDateTimeLabel(a.startsAt, zone)}`}
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (a) => (
                  <Link href={`/portal/appointments/${a.id}`} className="text-primary underline">
                    {formatDateTimeLabel(a.startsAt, zone)}
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (a) => humanize(a.kind) },
              { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
              { key: 'with', header: 'With', cell: (a) => a.staffName ?? '—', hideOnMobile: true },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}
