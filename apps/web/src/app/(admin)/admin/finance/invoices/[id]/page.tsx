import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Alert,
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { invoiceDetail } from '@/lib/admin/server/finance';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList, Mono } from '../../../_components/bits';
import { BankReceiptActions } from '../../_components/bank-receipt-actions';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

const ATTEMPT_OPEN = new Set(['initialized', 'pending', 'uncertain']);

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireStaffPage('finance.read');
  const { id } = await params;
  const loaded = await attempt(() => invoiceDetail(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This invoice" />;
  }
  const v = loaded.value;
  const inv = v.invoice;
  const me = identity.session!.user.id;
  const perms = {
    manage: can(identity, 'finance.invoices.manage'),
    reconcile: can(identity, 'finance.reconcile'),
    requestRefund: can(identity, 'finance.refunds.request'),
    approveRefund: can(identity, 'finance.refunds.approve'),
  };
  const creditable = ['issued', 'partially_paid', 'overdue', 'paid'].includes(inv.status);
  const voidable =
    ['draft', 'issued', 'overdue'].includes(inv.status) && BigInt(inv.amountPaidKobo) === 0n;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/finance/invoices" className="underline">
            Invoices
          </Link>
        }
        title={`Invoice ${inv.number}`}
        description={`${humanize(inv.kind)} · ${v.organizationName}`}
        actions={
          <>
            <StatusBadge status={inv.status} />
            {perms.manage && inv.status === 'draft' ? (
              <ApiAction
                path={`/api/v1/invoices/${inv.id}/issue`}
                body={{ expectedVersion: inv.version }}
                label="Issue invoice"
                variant="primary"
                confirm={{
                  title: `Issue ${inv.number}?`,
                  description:
                    'The customer can then pay it. Amounts are frozen once issued; corrections use credit notes.',
                  confirmLabel: 'Issue',
                }}
                successMessage="Invoice issued"
              />
            ) : null}
            {perms.manage && voidable ? (
              <ApiAction
                path={`/api/v1/invoices/${inv.id}/void`}
                reasonKey="reason"
                label="Void"
                variant="ghost"
                confirm={{
                  title: `Void ${inv.number}?`,
                  description:
                    'Voiding keeps the invoice and its history; it can no longer be paid. Paid invoices are corrected with credit notes or refunds instead.',
                  requireReason: true,
                  confirmLabel: 'Void invoice',
                  tone: 'danger',
                }}
                successMessage="Invoice voided"
              />
            ) : null}
            {perms.manage && creditable ? (
              <FormDialog
                trigger="Issue credit note"
                title={`Credit note against ${inv.number}`}
                description="A separate, numbered record that reduces what the customer owes. It never edits the invoice."
                path={`/api/v1/invoices/${inv.id}/credit-notes`}
                successMessage="Credit note issued"
                fields={[
                  { name: 'amountKobo', label: 'Amount (₦)', type: 'naira', required: true },
                  { name: 'reason', label: 'Reason', type: 'textarea', required: true },
                ]}
              />
            ) : null}
          </>
        }
      />
      {inv.status === 'void' ? (
        <Alert tone="info" title="Void">
          Voided {inv.voidedAt ? formatDateTimeLabel(inv.voidedAt) : ''}:{' '}
          {inv.voidReason ?? 'no reason recorded'}.
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section title="Lines">
            <DataTable
              caption="Invoice lines"
              rows={inv.lines}
              rowKey={(l) => l.id}
              rowLabel={(l) => l.description}
              columns={[
                { key: 'd', header: 'Description', cell: (l) => l.description },
                { key: 'q', header: 'Qty', cell: (l) => l.quantity },
                {
                  key: 'u',
                  header: 'Unit',
                  cell: (l) => <Money kobo={l.unitAmountKobo} currency={inv.currency} />,
                },
                {
                  key: 't',
                  header: 'Tax rate',
                  cell: (l) => `${(l.taxRateBps / 100).toFixed(2)}%`,
                  hideOnMobile: true,
                },
                {
                  key: 'tk',
                  header: 'Tax amount',
                  cell: (l) => <Money kobo={l.taxKobo} currency={inv.currency} />,
                  hideOnMobile: true,
                },
                {
                  key: 'a',
                  header: 'Amount',
                  cell: (l) => <Money kobo={l.amountKobo} currency={inv.currency} />,
                },
                {
                  key: 'acc',
                  header: 'Account',
                  cell: (l) => l.accountCode ?? '—',
                  hideOnMobile: true,
                },
              ]}
            />
          </Section>

          <Section
            title={`Payment attempts (${v.attempts.length})`}
            description="A browser redirect never settles money: only a server verification that matches reference, amount and currency allocates funds."
          >
            <DataTable
              caption="Payment attempts"
              rows={v.attempts}
              rowKey={(a) => a.id}
              rowLabel={(a) => a.reference}
              emptyMessage="No gateway payment has been started for this invoice."
              columns={[
                { key: 'ref', header: 'Reference', cell: (a) => <Mono>{a.reference}</Mono> },
                { key: 'st', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
                {
                  key: 'amt',
                  header: 'Amount',
                  cell: (a) => <Money kobo={a.amountKobo} currency={a.currency} />,
                },
                {
                  key: 'prov',
                  header: 'Provider',
                  cell: (a) => (
                    <span>
                      {a.provider} · {a.environment}
                      {a.developmentAdapter ? (
                        <Badge tone="warning" className="ml-1">
                          dev adapter
                        </Badge>
                      ) : null}
                    </span>
                  ),
                  hideOnMobile: true,
                },
                {
                  key: 'when',
                  header: 'Started',
                  cell: (a) => formatDateTimeLabel(a.createdAt),
                  hideOnMobile: true,
                },
                {
                  key: 'act',
                  header: 'Actions',
                  cell: (a) => (
                    <span className="flex flex-wrap gap-1">
                      {ATTEMPT_OPEN.has(a.status) && perms.reconcile ? (
                        <ApiAction
                          path={`/api/v1/payment-attempts/${a.id}/verify`}
                          label="Verify with provider"
                          successMessage="Verification recorded"
                        />
                      ) : null}
                      {a.status === 'successful' &&
                      perms.requestRefund &&
                      BigInt(v.refundableByAttempt[a.id] ?? '0') > 0n ? (
                        <FormDialog
                          trigger="Request refund"
                          title={`Refund from ${a.reference}`}
                          description={`Up to ${v.refundableByAttempt[a.id]} kobo remains refundable. Another finance user must approve the request; approval needs a verified authenticator.`}
                          path="/api/v1/refunds"
                          idempotent
                          successMessage="Refund requested"
                          extraBody={{ paymentAttemptId: a.id }}
                          fields={[
                            {
                              name: 'amountKobo',
                              label: 'Amount (₦, blank for the full payment)',
                              type: 'naira',
                            },
                            { name: 'reason', label: 'Reason', type: 'textarea', required: true },
                          ]}
                        />
                      ) : null}
                      {a.failureReason ? (
                        <span className="text-xs text-fg-muted">{a.failureReason}</span>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          </Section>

          <Section
            title={`Bank transfer declarations (${v.bankReceipts.length})`}
            description="An uploaded transfer receipt is not cleared money until finance confirms the amount on the statement."
          >
            <DataTable
              caption="Bank transfer declarations"
              rows={v.bankReceipts}
              rowKey={(b) => b.id}
              rowLabel={(b) => b.bankReference ?? b.id}
              emptyMessage="No bank transfer declared."
              columns={[
                {
                  key: 'amt',
                  header: 'Declared',
                  cell: (b) => <Money kobo={b.declaredAmountKobo} currency={inv.currency} />,
                },
                { key: 'ref', header: 'Bank reference', cell: (b) => b.bankReference ?? '—' },
                {
                  key: 'paid',
                  header: 'Paid on',
                  cell: (b) => b.declaredPaidAt ?? '—',
                  hideOnMobile: true,
                },
                {
                  key: 'file',
                  header: 'Evidence',
                  cell: (b) =>
                    b.uploadedFileId ? (
                      <a href={`/api/v1/files/${b.uploadedFileId}/download`} className="underline">
                        download
                      </a>
                    ) : (
                      '—'
                    ),
                  hideOnMobile: true,
                },
                {
                  key: 'st',
                  header: 'Status',
                  cell: (b) => (
                    <StatusBadge
                      status={
                        b.status === 'confirmed'
                          ? 'successful'
                          : b.status === 'rejected'
                            ? 'rejected'
                            : 'pending'
                      }
                      label={humanize(b.status)}
                    />
                  ),
                },
                {
                  key: 'act',
                  header: 'Review',
                  cell: (b) =>
                    ['submitted', 'under_review'].includes(b.status) ? (
                      <BankReceiptActions
                        receiptId={b.id}
                        declaredAmountKobo={b.declaredAmountKobo}
                        invoiceBalanceKobo={inv.balanceKobo}
                        invoiceNumber={inv.number}
                        canReconcile={perms.reconcile}
                      />
                    ) : (
                      <span className="text-xs text-fg-muted">
                        {b.reviewNote ?? (b.reviewedAt ? formatDateTimeLabel(b.reviewedAt) : '')}
                      </span>
                    ),
                },
              ]}
            />
          </Section>

          <Section
            title={`Refunds (${v.refunds.length})`}
            description="Requested → approved by someone other than the requester → submitted to the provider → settled only when the provider confirms."
          >
            <DataTable
              caption="Refunds"
              rows={v.refunds}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.id}
              emptyMessage="No refunds."
              columns={[
                {
                  key: 'amt',
                  header: 'Amount',
                  cell: (r) => <Money kobo={r.amountKobo} currency={r.currency} />,
                },
                {
                  key: 'st',
                  header: 'Status',
                  cell: (r) => (
                    <StatusBadge
                      status={r.status === 'settled' ? 'successful' : r.status}
                      label={humanize(r.status)}
                    />
                  ),
                },
                { key: 'reason', header: 'Reason', cell: (r) => r.reason },
                {
                  key: 'who',
                  header: 'Requested / approved',
                  cell: (r) => `${r.requestedByName ?? '—'} / ${r.approvedByName ?? '—'}`,
                  hideOnMobile: true,
                },
                {
                  key: 'act',
                  header: 'Decision',
                  cell: (r) =>
                    r.status === 'requested' && perms.approveRefund ? (
                      <span className="flex flex-wrap gap-1">
                        <ApiAction
                          path={`/api/v1/refunds/${r.id}/approve`}
                          reasonKey="reason"
                          label="Approve"
                          variant="primary"
                          disabled={r.requestedBy === me}
                          disabledReason="You requested this refund; another finance user must approve it."
                          confirm={{
                            title: 'Approve this refund?',
                            description:
                              'Posts the refund liability and queues submission to the provider. It is marked settled only when the provider confirms.',
                            confirmLabel: 'Approve refund',
                          }}
                          successMessage="Refund approved"
                        />
                        <ApiAction
                          path={`/api/v1/refunds/${r.id}/reject`}
                          reasonKey="reason"
                          label="Reject"
                          variant="ghost"
                          confirm={{
                            title: 'Reject this refund?',
                            requireReason: true,
                            confirmLabel: 'Reject',
                            tone: 'danger',
                          }}
                          successMessage="Refund rejected"
                        />
                      </span>
                    ) : (
                      <span className="text-xs text-fg-muted">
                        {r.failureReason ?? r.providerStatus ?? ''}
                      </span>
                    ),
                },
              ]}
            />
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Amounts">
            <DefinitionList
              items={[
                {
                  term: 'Subtotal',
                  value: <Money kobo={inv.subtotalKobo} currency={inv.currency} />,
                },
                { term: 'Tax', value: <Money kobo={inv.taxKobo} currency={inv.currency} /> },
                {
                  term: 'Withholding',
                  value: <Money kobo={inv.withholdingKobo} currency={inv.currency} />,
                },
                {
                  term: 'Total',
                  value: (
                    <strong>
                      <Money kobo={inv.totalKobo} currency={inv.currency} />
                    </strong>
                  ),
                },
                {
                  term: 'Paid (settled)',
                  value: <Money kobo={inv.amountPaidKobo} currency={inv.currency} />,
                },
                {
                  term: 'Credited',
                  value: <Money kobo={inv.amountCreditedKobo} currency={inv.currency} />,
                },
                {
                  term: 'Balance',
                  value: (
                    <strong>
                      <Money kobo={inv.balanceKobo} currency={inv.currency} />
                    </strong>
                  ),
                },
                { term: 'Tax treatment', value: inv.taxTreatmentKey },
              ]}
            />
          </Section>
          <Section title="Details">
            <DefinitionList
              items={[
                {
                  term: 'Organisation',
                  value: (
                    <Link href={`/admin/customers/${inv.organizationId}`} className="underline">
                      {v.organizationName}
                    </Link>
                  ),
                },
                { term: 'Customer', value: v.customer?.name ?? null },
                {
                  term: 'Service request',
                  value: v.serviceRequest ? (
                    <Link
                      href={`/admin/service-requests/${v.serviceRequest.id}`}
                      className="underline"
                    >
                      {v.serviceRequest.reference} · {v.serviceRequest.title}
                    </Link>
                  ) : null,
                },
                { term: 'Due date', value: inv.dueDate ? formatDateLabel(inv.dueDate) : null },
                { term: 'Issued', value: inv.issuedAt ? formatDateTimeLabel(inv.issuedAt) : null },
                { term: 'Paid', value: inv.paidAt ? formatDateTimeLabel(inv.paidAt) : null },
                { term: 'Version', value: inv.version },
              ]}
            />
            {inv.notes ? (
              <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-2">{inv.notes}</p>
            ) : null}
            {inv.installmentPlan && inv.installmentPlan.length > 0 ? (
              <div>
                <p className="font-medium">Installment plan</p>
                <ul className="mt-1 space-y-1">
                  {inv.installmentPlan.map((i, n) => (
                    <li key={n} className="flex justify-between gap-2">
                      <span>
                        {i.label}
                        {i.dueDate ? ` · due ${i.dueDate}` : ''}
                      </span>
                      <Money kobo={i.amountKobo} currency={inv.currency} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>
          <Section
            title={`Receipts (${v.receipts.length})`}
            description="One per allocation; the source says where the money came from."
          >
            {v.receipts.length === 0 ? (
              <p className="text-fg-muted">No money allocated yet.</p>
            ) : (
              <ul className="space-y-1">
                {v.receipts.map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <Mono>{r.number}</Mono>{' '}
                      <span className="text-xs text-fg-muted">
                        {humanize(r.source)} · {formatDateTimeLabel(r.issuedAt)}
                      </span>
                    </span>
                    <Money kobo={r.amountKobo} currency={r.currency} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={`Credit notes (${v.creditNotes.length})`}>
            {v.creditNotes.length === 0 ? (
              <p className="text-fg-muted">None.</p>
            ) : (
              <ul className="space-y-1">
                {v.creditNotes.map((c) => (
                  <li key={c.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <Mono>{c.number}</Mono>{' '}
                      <span className="text-xs text-fg-muted">
                        {humanize(c.status)} · {c.reason}
                      </span>
                    </span>
                    <Money kobo={c.amountKobo} currency={c.currency} />
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
