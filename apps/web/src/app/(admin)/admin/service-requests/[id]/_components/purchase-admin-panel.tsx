import Link from 'next/link';
import type { FileDto, PurchaseItemDto } from '@simplexd/contracts';
import { Alert, Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { koboToNaira } from '@/lib/portal/format';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Section } from '@/components/admin/section';
import { OfferActions } from '@/components/portal/search-purchase';
import { listFilesForEntity } from '@/server/files/queries';
import { getPurchaseWorkspace } from '@/server/purchase/closing';
import { getSearchWorkspace } from '@/server/search/shortlists';

/**
 * Staff side of purchase representation: the agreed fee basis (a
 * percentage quote that needs the agreed basis amount and the signed scope),
 * offers and the negotiation log, conditions, the diligence dependency, the
 * closing checklist, document handover and the closing pack.
 */

const KIND_LABEL: Record<PurchaseItemDto['kind'], string> = {
  condition: 'condition',
  closing_task: 'closing task',
  handover_document: 'handover document',
};

function fileOptions(files: FileDto[]) {
  return files
    .filter((f) => f.status === 'clean')
    .map((f) => ({ value: f.id, label: f.originalName }));
}

function ItemRows({
  items,
  files,
  canManage,
  closed,
}: {
  items: PurchaseItemDto[];
  files: FileDto[];
  canManage: boolean;
  closed: boolean;
}) {
  if (items.length === 0) return <p className="text-fg-muted">None recorded.</p>;
  return (
    <ul className="space-y-2">
      {items.map((i) => {
        const open = i.status === 'open' || i.status === 'in_progress';
        const path = `/api/v1/purchase-items/${i.id}`;
        return (
          <li key={i.id} className="space-y-1 rounded-md border border-border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{i.title}</span>
              <StatusBadge status={i.status} />
              {i.visibility === 'internal' ? <Badge tone="neutral">Internal</Badge> : null}
              {i.kind === 'handover_document' ? (
                <Badge tone={i.acknowledged ? 'success' : 'warning'}>
                  {i.acknowledged
                    ? 'Receipt acknowledged'
                    : i.files.length > 0
                      ? 'Awaiting acknowledgement'
                      : 'No file yet'}
                </Badge>
              ) : null}
              {i.offerId ? <Badge tone="info">From the accepted offer</Badge> : null}
            </div>
            {i.detail ? <p className="text-xs text-fg-muted">{i.detail}</p> : null}
            {i.resolutionNote ? (
              <p className="text-xs text-fg-muted">
                {humanize(i.status)}: {i.resolutionNote}
                {i.resolvedByName ? ` (${i.resolvedByName})` : ''}
              </p>
            ) : null}
            {i.files.length > 0 ? (
              <p className="text-xs text-fg-muted">
                Files: {i.files.map((f) => f.name).join(', ')}
              </p>
            ) : null}
            {canManage && !closed && open ? (
              <div className="flex flex-wrap gap-2">
                {i.kind !== 'handover_document' ? (
                  <ApiAction
                    path={path}
                    method="PATCH"
                    body={{ status: 'satisfied', expectedVersion: i.version }}
                    label="Satisfied"
                    successMessage="Marked satisfied"
                  />
                ) : null}
                <ApiAction
                  path={path}
                  method="PATCH"
                  body={{ status: 'waived', expectedVersion: i.version }}
                  reasonKey="reason"
                  label="Waive"
                  confirm={{
                    title: `Waive this ${KIND_LABEL[i.kind]}`,
                    requireReason: true,
                    confirmLabel: 'Waive',
                  }}
                />
                <ApiAction
                  path={path}
                  method="PATCH"
                  body={{ status: 'failed', expectedVersion: i.version }}
                  reasonKey="reason"
                  label="Failed"
                  confirm={{
                    title: `Record that this ${KIND_LABEL[i.kind]} failed`,
                    requireReason: true,
                    confirmLabel: 'Record',
                    tone: 'danger',
                  }}
                />
                {files.length > 0 ? (
                  <FormDialog
                    trigger="Attach files"
                    title="Attach files from this request"
                    path={path}
                    method="PATCH"
                    size="sm"
                    submitLabel="Attach"
                    extraBody={{ expectedVersion: i.version }}
                    fields={[
                      {
                        name: 'addFileIds',
                        label: 'File',
                        type: 'select',
                        required: true,
                        options: fileOptions(files),
                        list: true,
                        wide: true,
                        hint: 'Upload files in the Documents section first; only clean files are offered.',
                      },
                    ]}
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export async function PurchaseAdminPanel({
  identity,
  requestId,
  requestVersion,
  canManage,
  canQuote,
  canOverride,
  closed,
}: {
  identity: RequestIdentity;
  requestId: string;
  requestVersion: number;
  canManage: boolean;
  canQuote: boolean;
  canOverride: boolean;
  closed: boolean;
}) {
  const [ws, search, files] = await Promise.all([
    attempt(() => getPurchaseWorkspace(identity, requestId)),
    attempt(() => getSearchWorkspace(identity, requestId)),
    listFilesForEntity(identity, { entityType: 'service_request', entityId: requestId, limit: 100 })
      .then((p) => p.items)
      .catch(() => [] as FileDto[]),
  ]);
  if (!ws.ok) {
    return (
      <Section id="purchase" title="Purchase representation">
        <LoadError code={ws.code} message={ws.message} what="Purchase workspace" />
      </Section>
    );
  }
  const w = ws.value;
  const entries = search.ok
    ? search.value.shortlists.flatMap((s) => s.items.filter((i) => i.status !== 'removed'))
    : [];
  const liveOffer = w.offers.some((o) =>
    ['draft', 'submitted', 'countered', 'accepted'].includes(o.status),
  );
  const itemPath = `/api/v1/service-requests/${requestId}/purchase/items`;
  const addItem = (kind: PurchaseItemDto['kind'], label: string) => (
    <FormDialog
      trigger={label}
      title={label}
      path={itemPath}
      submitLabel="Add"
      successMessage="Added"
      extraBody={{ kind }}
      fields={[
        { name: 'title', label: 'Title', required: true, wide: true },
        { name: 'detail', label: 'Detail', type: 'textarea', wide: true },
        { name: 'dueAt', label: 'Due', type: 'datetime' },
        {
          name: 'visibility',
          label: 'Visibility',
          type: 'select',
          defaultValue: 'customer',
          options: [
            { value: 'customer', label: 'Customer and staff' },
            { value: 'all', label: 'Customer, staff and assigned partners' },
            { value: 'internal', label: 'Staff only' },
          ],
        },
        ...(kind === 'handover_document' && files.length > 0
          ? [
              {
                name: 'fileIds',
                label: 'Files',
                type: 'select' as const,
                options: fileOptions(files),
                list: true,
                wide: true,
                hint: 'Clean files already on this request.',
              },
            ]
          : []),
      ]}
    />
  );
  return (
    <Section
      id="purchase"
      title="Purchase representation"
      description="Fee basis, offers and negotiation log, conditions, diligence dependency, closing checklist and document handover. Completion evidence is the released closing pack plus the agreed fee basis."
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="font-medium">Fee basis (brief §2)</p>
          {w.feeBasis.agreedAt ? (
            <Alert tone="success" title="Fee basis agreed">
              {((w.feeBasis.percentageBps ?? 0) / 100).toFixed(2)}% of{' '}
              {w.feeBasis.basisDescription ?? 'the agreed basis'}
              {w.feeBasis.basisAmountKobo
                ? ` (${koboToNaira(w.feeBasis.basisAmountKobo, { whole: true })})`
                : ''}{' '}
              = {w.feeBasis.feeKobo ? koboToNaira(w.feeBasis.feeKobo, { whole: true }) : '—'},
              agreed {formatDateTimeLabel(w.feeBasis.agreedAt)}.
            </Alert>
          ) : (
            <>
              <p className="text-fg-muted">
                Not agreed yet. Draft the percentage quote below: it needs the agreed basis amount
                (purchase price or cap) and the customer-signed scope attached to this request;
                issue and acceptance are refused otherwise. The invoice is computed from the basis
                only.
              </p>
              {canQuote && !closed ? (
                <FormDialog
                  trigger="Draft percentage-basis quote"
                  title="Percentage-basis quote"
                  description="The single fee line is derived from the basis amount; typed lines are never used for a percentage fee."
                  path={`/api/v1/service-requests/${requestId}/quotes`}
                  submitLabel="Draft quote"
                  successMessage="Quote drafted — issue it from the Quotations section"
                  extraBody={{ currency: 'NGN' }}
                  fields={[
                    {
                      name: 'percentageBps',
                      bodyKey: 'feeBasis.percentageBps',
                      label: 'Percentage (basis points)',
                      type: 'number',
                      required: true,
                      defaultValue: 150,
                      hint: '150 = 1.50%',
                    },
                    {
                      name: 'basisAmountKobo',
                      bodyKey: 'feeBasis.basisAmountKobo',
                      label: 'Agreed basis amount (₦)',
                      type: 'naira',
                      required: true,
                    },
                    {
                      name: 'basisKind',
                      bodyKey: 'feeBasis.basisKind',
                      label: 'Basis',
                      type: 'select',
                      defaultValue: 'agreed_purchase_price',
                      options: [
                        { value: 'agreed_purchase_price', label: 'Agreed purchase price' },
                        { value: 'agreed_cap', label: 'Explicit cap agreed with the customer' },
                      ],
                    },
                    {
                      name: 'basisDescription',
                      bodyKey: 'feeBasis.basisDescription',
                      label: 'Basis description',
                      required: true,
                      wide: true,
                      hint: 'e.g. “the agreed purchase price of Plot 5 (₦46,000,000)”.',
                    },
                    {
                      name: 'signedScopeFileId',
                      bodyKey: 'feeBasis.signedScopeFileId',
                      label: 'Signed scope document',
                      type: 'select',
                      required: true,
                      options: fileOptions(files),
                      wide: true,
                      hint:
                        files.length === 0
                          ? 'Upload the signed scope in the Documents section first.'
                          : 'A clean file attached to this request.',
                    },
                    {
                      name: 'scopeMarkdown',
                      label: 'Scope',
                      type: 'textarea',
                      required: true,
                      wide: true,
                    },
                    { name: 'exclusions', label: 'Exclusions', type: 'textarea', wide: true },
                    {
                      name: 'depositBps',
                      label: 'Deposit on acceptance (basis points)',
                      type: 'number',
                      defaultValue: 10000,
                      hint: '10000 = the whole fee; 0 = no upfront payment',
                    },
                    {
                      name: 'requiresPayment',
                      label: 'Requires payment before work',
                      type: 'checkbox',
                      defaultValue: true,
                    },
                  ]}
                />
              ) : null}
            </>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">Offers and negotiation log</p>
            {canManage && !closed && !liveOffer && entries.length > 0 ? (
              <FormDialog
                trigger="Draft an offer"
                title="Draft an offer for the buyer"
                path={`/api/v1/service-requests/${requestId}/purchase/offers`}
                submitLabel="Save draft"
                successMessage="Offer drafted"
                fields={[
                  {
                    name: 'shortlistItemId',
                    label: 'Property',
                    type: 'select',
                    required: true,
                    options: entries.map((e) => ({ value: e.id, label: e.title })),
                    wide: true,
                  },
                  { name: 'amountKobo', label: 'Amount (₦)', type: 'naira', required: true },
                  {
                    name: 'conditions',
                    label: 'Terms',
                    type: 'textarea',
                    list: true,
                    hint: 'One per line; tracked as conditions once accepted.',
                    wide: true,
                  },
                  { name: 'expiresAt', label: 'Valid until', type: 'datetime' },
                  { name: 'note', label: 'Note (customer instruction)', wide: true },
                ]}
              />
            ) : null}
          </div>
          {w.offers.length === 0 ? (
            <p className="text-fg-muted">
              No offer yet.{entries.length === 0 ? ' Shortlist a property first.' : ''}
            </p>
          ) : (
            w.offers.map((o) => (
              <div key={o.id} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o.subjectTitle}</span>
                  <StatusBadge status={o.status} />
                  <span className="text-fg-muted">
                    {koboToNaira(o.amountKobo, { whole: true })}
                  </span>
                  {o.externalReference ? (
                    <span className="text-xs text-fg-muted">{o.externalReference}</span>
                  ) : null}
                </div>
                {o.conditions.length > 0 ? (
                  <p className="text-xs">Terms: {o.conditions.join('; ')}</p>
                ) : null}
                <ol className="space-y-1 border-l border-border pl-3 text-xs">
                  {o.negotiationLog.map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      <span className="text-fg-muted">{formatDateTimeLabel(e.at)}</span> ·{' '}
                      <strong>{humanize(e.action)}</strong>
                      {e.amountKobo ? ` ${koboToNaira(e.amountKobo, { whole: true })}` : ''}
                      {e.byName ? ` · ${e.byName}` : ''}
                      {e.actor ? ` (${e.actor})` : ''}
                      {e.note ? ` — ${e.note}` : ''}
                    </li>
                  ))}
                </ol>
                {canManage && !closed ? <OfferActions offer={o} canCommit staff /> : null}
              </div>
            ))
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Conditions</p>
              {canManage && !closed ? addItem('condition', 'Add condition') : null}
            </div>
            <ItemRows items={w.conditions} files={files} canManage={canManage} closed={closed} />
          </div>
          <div className="space-y-2">
            <p className="font-medium">Diligence dependency</p>
            {w.diligence.request ? (
              <p>
                <Link
                  href={`/admin/service-requests/${w.diligence.request.id}`}
                  className="underline"
                >
                  {w.diligence.request.reference}
                </Link>{' '}
                ({humanize(w.diligence.request.status)}) · {w.diligence.openRedFlags ?? 0}{' '}
                unresolved red flag(s) · memorandum{' '}
                {w.diligence.memoReleased ? 'released' : 'not released'}
              </p>
            ) : (
              <p className="text-fg-muted">No due-diligence request linked.</p>
            )}
            {w.diligence.waived ? (
              <Alert tone="warning" title="Waived">
                {w.diligence.waiverReason}
              </Alert>
            ) : w.diligence.clear ? (
              <Alert tone="success" title="Clear">
                Closing is not blocked by diligence.
              </Alert>
            ) : (
              <ul className="list-disc pl-5 text-fg-muted">
                {w.diligence.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            )}
            {canManage && !closed ? (
              <div className="flex flex-wrap gap-2">
                {w.diligence.candidates.length > 0 ? (
                  <FormDialog
                    trigger={w.diligence.request ? 'Relink' : 'Link due-diligence request'}
                    title="Link the due-diligence request"
                    path={`/api/v1/service-requests/${requestId}/purchase/diligence`}
                    method="PUT"
                    submitLabel="Link"
                    successMessage="Diligence request linked"
                    fields={[
                      {
                        name: 'diligenceRequestId',
                        label: 'Due-diligence request',
                        type: 'select',
                        required: true,
                        options: w.diligence.candidates.map((c) => ({
                          value: c.id,
                          label: `${c.reference} · ${c.title} (${humanize(c.status)})`,
                        })),
                        wide: true,
                      },
                    ]}
                  />
                ) : (
                  <p className="text-xs text-fg-muted">
                    This customer has no due-diligence request to link yet.
                  </p>
                )}
                {canOverride && !w.diligence.waived ? (
                  <ApiAction
                    path={`/api/v1/service-requests/${requestId}/purchase/diligence/waive`}
                    body={{}}
                    reasonKey="reason"
                    label="Waive dependency"
                    confirm={{
                      title: 'Waive the diligence dependency',
                      description:
                        'Closing will no longer wait for diligence. The reason is recorded and shown to the customer.',
                      requireReason: true,
                      confirmLabel: 'Waive',
                      tone: 'danger',
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Closing checklist</p>
              {canManage && !closed ? addItem('closing_task', 'Add closing task') : null}
            </div>
            <ItemRows items={w.closingTasks} files={files} canManage={canManage} closed={closed} />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Document handover</p>
              {canManage && !closed ? addItem('handover_document', 'Add handover document') : null}
            </div>
            <ItemRows
              items={w.handoverDocuments}
              files={files}
              canManage={canManage}
              closed={closed}
            />
          </div>
        </div>

        <div className="space-y-2">
          <p className="font-medium">Closing pack</p>
          {w.readiness.ready ? (
            <Alert tone="success" title="Ready to close">
              Every blocker is cleared.
            </Alert>
          ) : (
            <ul className="list-disc pl-5 text-fg-muted">
              {w.readiness.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          )}
          {w.closing.length > 0 ? (
            <ul className="space-y-1">
              {w.closing.map((c) => (
                <li key={c.reportId}>
                  <Link href={`/admin/reports/${c.reportId}`} className="underline">
                    Closing pack — {humanize(c.reportStatus)}
                  </Link>{' '}
                  <span className="text-xs text-fg-muted">
                    {formatDateTimeLabel(c.at)}
                    {c.byName ? ` · ${c.byName}` : ''} · {c.handedOverDocuments.length} document(s)
                    handed over
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {canManage && !closed && w.closing.length === 0 ? (
            <ApiAction
              path={`/api/v1/service-requests/${requestId}/purchase/closing-pack`}
              body={{ expectedVersion: requestVersion }}
              label="Prepare closing pack"
              variant="primary"
              disabled={!w.readiness.ready}
              disabledReason="Clear every blocker first"
              successMessage="Closing pack drafted — submit it for review"
              redirectTo="/admin/reports/{id}"
            />
          ) : null}
        </div>
      </div>
    </Section>
  );
}
