import Link from 'next/link';
import type { PurchaseItemDto } from '@simplexd/contracts';
import {
  Alert,
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
import type { RequestIdentity } from '@/lib/auth/session';
import { koboToNaira } from '@/lib/portal/format';
import { capabilityNote, type CustomerCapabilities } from '@/lib/portal/server/permissions';
import { AcknowledgeHandoverButton, OfferActions, OfferComposer } from '@/components/portal/search-purchase';
import { getPurchaseWorkspace } from '@/server/purchase/closing';
import { getSearchWorkspace } from '@/server/search/shortlists';

/**
 * Customer view of purchase representation: offers with the negotiation
 * log, conditions, the diligence dependency, the closing checklist, document
 * handover (acknowledged by the customer) and the closing pack record.
 */

function ItemList({
  items,
  empty,
  zone,
  children,
}: {
  items: PurchaseItemDto[];
  empty: string;
  zone: string;
  children?: (item: PurchaseItemDto) => React.ReactNode;
}) {
  if (items.length === 0) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.id} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{i.title}</span>
            <StatusBadge status={i.status} />
          </div>
          {i.detail ? <p className="mt-1 text-sm text-fg-muted">{i.detail}</p> : null}
          {i.dueAt ? <p className="text-xs text-fg-muted">Due {formatDateTimeLabel(i.dueAt, zone)}</p> : null}
          {i.resolutionNote && i.status !== 'satisfied' ? (
            <p className="text-xs text-fg-muted">
              {humanize(i.status)}: {i.resolutionNote}
            </p>
          ) : null}
          {i.files.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {i.files.map((f) => (
                <li key={f.id}>
                  <Badge tone={f.status === 'clean' ? 'neutral' : 'warning'}>{f.name}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {children ? <div className="mt-2">{children(i)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export async function PurchaseTab({
  identity,
  requestId,
  caps,
  zone,
  closed,
}: {
  identity: RequestIdentity;
  requestId: string;
  caps: CustomerCapabilities;
  zone: string;
  closed: boolean;
}) {
  const [ws, search] = await Promise.all([
    getPurchaseWorkspace(identity, requestId),
    getSearchWorkspace(identity, requestId),
  ]);
  const entries = search.shortlists.flatMap((s) => s.items.filter((i) => i.status !== 'removed'));
  const live = ws.offers.some((o) => ['draft', 'submitted', 'countered', 'accepted'].includes(o.status));
  const commitReason = capabilityNote(caps, 'Committing the organisation to an offer');
  return (
    <section aria-label="Purchase representation" className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>Offers and negotiation</CardTitle>
              <CardDescription>
                Every step is recorded in an append-only log. Your representative records the seller&apos;s
                responses; only an owner or approver commits the organisation.
              </CardDescription>
            </div>
            {!closed && !live && caps.can('org.requests.create') ? (
              <OfferComposer serviceRequestId={requestId} entries={entries.map((e) => ({ id: e.id, title: e.title }))} />
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {ws.offers.length === 0 ? (
            <EmptyState
              title="No offer yet"
              description="Once a shortlisted property is chosen, draft an offer here or ask your representative to."
            />
          ) : (
            ws.offers.map((o) => (
              <div key={o.id} className="space-y-3 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{o.subjectTitle}</p>
                    <p className="text-sm text-fg-muted">
                      {koboToNaira(o.amountKobo, { whole: true })}
                      {o.expiresAt ? ` · valid until ${formatDateTimeLabel(o.expiresAt, zone)}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                {o.conditions.length > 0 ? (
                  <p className="text-sm">
                    <span className="text-fg-muted">Terms:</span> {o.conditions.join('; ')}
                  </p>
                ) : null}
                <ol className="space-y-1 border-l border-border pl-3 text-xs">
                  {o.negotiationLog.map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      <span className="text-fg-muted">{formatDateTimeLabel(e.at, zone)}</span> ·{' '}
                      <strong>{humanize(e.action)}</strong>
                      {e.amountKobo ? ` ${koboToNaira(e.amountKobo, { whole: true })}` : ''}
                      {e.byName ? ` · ${e.byName}` : ''}
                      {e.note ? ` — ${e.note}` : ''}
                    </li>
                  ))}
                </ol>
                {!closed ? (
                  <OfferActions offer={o} canCommit={caps.acceptQuotes} cannotCommitReason={commitReason} />
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle>Conditions</CardTitle>
            <CardDescription>Terms the purchase depends on; each is satisfied or waived with a reason.</CardDescription>
          </CardHeader>
          <CardContent>
            <ItemList items={ws.conditions} empty="No conditions recorded yet." zone={zone} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Diligence dependency</CardTitle>
            <CardDescription>Closing waits for your due-diligence request to be clear.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {ws.diligence.request ? (
              <p>
                Linked request:{' '}
                <Link href={`/portal/requests/${ws.diligence.request.id}`} className="text-primary underline">
                  {ws.diligence.request.reference}
                </Link>{' '}
                ({humanize(ws.diligence.request.status)})
              </p>
            ) : null}
            {ws.diligence.waived ? (
              <Alert tone="warning" title="Dependency waived">
                {ws.diligence.waiverReason}
              </Alert>
            ) : ws.diligence.clear ? (
              <Alert tone="success" title="Diligence clear">
                No unresolved red flags and the diligence memorandum has been released.
              </Alert>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-fg-muted">
                {ws.diligence.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Closing checklist</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemList items={ws.closingTasks} empty="No closing tasks yet." zone={zone} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Document handover</CardTitle>
            <CardDescription>
              Acknowledge each document once you have received and checked it. Files open from the Documents tab.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ItemList items={ws.handoverDocuments} empty="No documents handed over yet." zone={zone}>
              {(i) =>
                i.acknowledged ? (
                  <p className="text-xs text-fg-muted">
                    Receipt acknowledged {i.resolvedAt ? formatDateTimeLabel(i.resolvedAt, zone) : ''}
                    {i.resolvedByName ? ` by ${i.resolvedByName}` : ''}.
                  </p>
                ) : ['open', 'in_progress'].includes(i.status) && !closed ? (
                  i.files.length === 0 ? (
                    <p className="text-xs text-fg-muted">Awaiting the file from the team.</p>
                  ) : (
                    <AcknowledgeHandoverButton
                      itemId={i.id}
                      expectedVersion={i.version}
                      disabledReason={caps.viewDocuments ? undefined : capabilityNote(caps, 'Acknowledging documents')}
                    />
                  )
                ) : null
              }
            </ItemList>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Fee basis and closing</CardTitle>
          <CardDescription>
            Purchase representation is charged on an agreed percentage basis with a signed scope; the closing pack is
            released by a reviewer once every item above is resolved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {ws.feeBasis.agreedAt ? (
            <p>
              Agreed fee: {((ws.feeBasis.percentageBps ?? 0) / 100).toFixed(2)}% of{' '}
              {ws.feeBasis.basisDescription ?? 'the agreed basis'}
              {ws.feeBasis.basisAmountKobo ? ` (${koboToNaira(ws.feeBasis.basisAmountKobo, { whole: true })})` : ''} ={' '}
              <strong>{ws.feeBasis.feeKobo ? koboToNaira(ws.feeBasis.feeKobo, { whole: true }) : '—'}</strong>, agreed{' '}
              {formatDateTimeLabel(ws.feeBasis.agreedAt, zone)}.
            </p>
          ) : (
            <p className="text-fg-muted">
              No fee basis agreed yet: it is fixed when you accept the percentage quote that names the agreed purchase
              price (or cap) and references the scope you signed.
            </p>
          )}
          {ws.readiness.blockers.length > 0 ? (
            <div>
              <p className="font-medium">Before closing</p>
              <ul className="list-disc space-y-1 pl-5 text-fg-muted">
                {ws.readiness.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-success">Everything is in place for the closing pack.</p>
          )}
          {ws.closing.length === 0 ? null : (
            <ul className="space-y-1">
              {ws.closing.map((c) => (
                <li key={c.reportId}>
                  <Link href={`/portal/reports/${c.reportId}`} className="text-primary underline">
                    Closing pack ({c.stage === 'approved' ? 'approved' : humanize(c.reportStatus)})
                  </Link>{' '}
                  <span className="text-fg-muted">
                    {formatDateTimeLabel(c.at, zone)}
                    {c.byName ? ` · ${c.byName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
