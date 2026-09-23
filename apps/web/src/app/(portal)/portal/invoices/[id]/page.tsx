import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { uuidSchema } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateLabel,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { koboToNaira } from '@/lib/portal/format';
import { paymentOutcomeCopy } from '@/lib/portal/payments';
import { loadInvoiceDetail } from '@/lib/portal/server/finance';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { BankTransferForm } from '@/components/portal/bank-transfer-form';
import { InvoicePay } from '@/components/portal/invoice-pay';
import { SignedDownloadButton } from '@/components/portal/signed-download';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `payment` (the callback's decision) is ignored: the alert is derived from the stored attempt. */
  searchParams: Promise<{ payment?: string; attempt?: string }>;
}) {
  const { id } = await params;
  const { attempt: attemptParam } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/invoices/${id}`);
  const detail = await loadInvoiceDetail(identity, id);
  if (!detail) notFound();
  const { invoice, receipts, attempts, bankReceipts } = detail;
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity, invoice.organizationId);
  // Returning from checkout carries ?attempt=; the outcome shown is the status the server stored
  // after verifying with the provider, never a value taken from the URL.
  const returnedAttempt = attemptParam
    ? (attempts.find((a) => a.id === attemptParam) ?? null)
    : null;
  const outcome = returnedAttempt ? paymentOutcomeCopy(returnedAttempt) : null;
  const payable = ['issued', 'partially_paid', 'overdue'].includes(invoice.status);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/invoices" className="underline">
            Invoices
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{invoice.number}</span>
            <StatusBadge status={invoice.status} />
          </span>
        }
        description={`${humanize(invoice.kind)} invoice${invoice.issuedAt ? ` issued ${formatDateLabel(invoice.issuedAt, zone)}` : ''}${invoice.dueDate ? ` · due ${formatDateLabel(invoice.dueDate, zone)}` : ''}`}
        actions={
          payable ? (
            <InvoicePay
              invoice={invoice}
              canPay={caps.payInvoices}
              cannotPayReason={
                caps.payInvoices ? undefined : capabilityNote(caps, 'Paying an invoice')
              }
            />
          ) : undefined
        }
      />

      {outcome && returnedAttempt ? (
        <Alert tone={outcome.tone} title={outcome.title}>
          {outcome.body} Reference <code className="font-mono">{returnedAttempt.reference}</code>.{' '}
          <Link
            href={`/portal/payments/return?attempt=${returnedAttempt.id}`}
            className="underline"
          >
            {outcome.recheck ? 'Check the payment again' : 'See the verification detail'}
          </Link>
          .
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
              <CardDescription>
                Amounts are computed by the server in kobo; tax follows the treatment on the
                quotation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[480px] text-sm">
                  <caption className="sr-only">Invoice lines</caption>
                  <thead className="bg-bg-sunken text-left text-xs uppercase tracking-wide text-fg-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Description
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Qty
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Unit
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Tax
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lines.map((l) => (
                      <tr key={l.id} className="border-t border-border">
                        <td className="px-3 py-2">{l.description}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {koboToNaira(l.unitAmountKobo)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {koboToNaira(l.taxKobo)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {koboToNaira(l.amountKobo)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-border">
                    <tr>
                      <th
                        scope="row"
                        colSpan={4}
                        className="px-3 py-1.5 text-right font-normal text-fg-muted"
                      >
                        Subtotal
                      </th>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {koboToNaira(invoice.subtotalKobo)}
                      </td>
                    </tr>
                    <tr>
                      <th
                        scope="row"
                        colSpan={4}
                        className="px-3 py-1.5 text-right font-normal text-fg-muted"
                      >
                        Tax
                      </th>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {koboToNaira(invoice.taxKobo)}
                      </td>
                    </tr>
                    {invoice.withholdingKobo !== '0' ? (
                      <tr>
                        <th
                          scope="row"
                          colSpan={4}
                          className="px-3 py-1.5 text-right font-normal text-fg-muted"
                        >
                          Withholding
                        </th>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {koboToNaira(invoice.withholdingKobo)}
                        </td>
                      </tr>
                    ) : null}
                    <tr className="font-semibold">
                      <th scope="row" colSpan={4} className="px-3 py-2 text-right">
                        Total ({invoice.currency})
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {koboToNaira(invoice.totalKobo)}
                      </td>
                    </tr>
                    <tr>
                      <th
                        scope="row"
                        colSpan={4}
                        className="px-3 py-1.5 text-right font-normal text-fg-muted"
                      >
                        Paid
                      </th>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {koboToNaira(invoice.amountPaidKobo)}
                      </td>
                    </tr>
                    {invoice.amountCreditedKobo !== '0' ? (
                      <tr>
                        <th
                          scope="row"
                          colSpan={4}
                          className="px-3 py-1.5 text-right font-normal text-fg-muted"
                        >
                          Credited
                        </th>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {koboToNaira(invoice.amountCreditedKobo)}
                        </td>
                      </tr>
                    ) : null}
                    <tr className="font-semibold">
                      <th scope="row" colSpan={4} className="px-3 py-2 text-right">
                        Balance
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {koboToNaira(invoice.balanceKobo)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {invoice.installmentPlan && invoice.installmentPlan.length > 0 ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-medium">Instalment plan</h3>
                  <ul className="space-y-1 text-sm">
                    {invoice.installmentPlan.map((p, i) => (
                      <li key={`${p.label}-${i}`} className="flex justify-between gap-3">
                        <span>
                          {p.label}
                          {p.dueDate ? (
                            <span className="text-fg-muted">
                              {' '}
                              · due {formatDateLabel(p.dueDate, zone)}
                            </span>
                          ) : null}
                        </span>
                        <span className="tabular-nums">{koboToNaira(p.amountKobo)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {invoice.notes ? (
                <p className="mt-4 whitespace-pre-wrap text-sm text-fg-muted">{invoice.notes}</p>
              ) : null}
              {invoice.voidReason ? (
                <Alert tone="warning" title="Invoice voided" className="mt-4">
                  {invoice.voidReason}
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          {payable ? (
            <Card>
              <CardHeader>
                <CardTitle>Pay by bank transfer</CardTitle>
                <CardDescription>
                  Transferred directly from your bank? Declare it here with the reference so finance
                  can match it on the statement. A declaration is not cleared money.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {caps.payInvoices ? (
                  <BankTransferForm
                    invoiceId={invoice.id}
                    invoiceNumber={invoice.number}
                    balanceKobo={invoice.balanceKobo}
                    canPay={caps.payInvoices}
                  />
                ) : (
                  <p className="text-sm text-fg-muted">
                    {capabilityNote(caps, 'Declaring a transfer')}
                  </p>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Payment history</CardTitle>
              <CardDescription>
                Every attempt and declaration with the status the server verified. A redirect back
                from checkout never counts as payment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {attempts.length === 0 ? (
                <p className="text-sm text-fg-muted">No card or bank checkout attempts yet.</p>
              ) : (
                <DataTable
                  caption="Checkout attempts"
                  rows={attempts}
                  rowKey={(a) => a.id}
                  rowLabel={(a) => `Attempt ${a.reference}`}
                  columns={[
                    {
                      key: 'reference',
                      header: 'Reference',
                      cell: (a) => (
                        <span className="flex flex-col">
                          <code className="font-mono text-xs">{a.reference}</code>
                          {a.developmentAdapter ? (
                            <span className="text-xs text-fg-muted">development adapter</span>
                          ) : null}
                        </span>
                      ),
                    },
                    {
                      key: 'amount',
                      header: 'Amount',
                      cell: (a) => koboToNaira(a.amountKobo),
                      className: 'text-right',
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      cell: (a) => <StatusBadge status={a.status} />,
                    },
                    {
                      key: 'channel',
                      header: 'Channel',
                      cell: (a) => (a.channel ? humanize(a.channel) : '—'),
                      hideOnMobile: true,
                    },
                    {
                      key: 'when',
                      header: 'Started',
                      cell: (a) => formatDateTimeLabel(a.createdAt, zone),
                    },
                    {
                      key: 'verified',
                      header: 'Verified',
                      cell: (a) =>
                        a.settledAt
                          ? `Settled ${formatDateTimeLabel(a.settledAt, zone)}`
                          : a.verifiedAt
                            ? formatDateTimeLabel(a.verifiedAt, zone)
                            : 'Not yet',
                      hideOnMobile: true,
                    },
                    {
                      key: 'action',
                      header: <span className="sr-only">Action</span>,
                      mobileLabel: 'Action',
                      cell: (a) =>
                        a.status === 'pending' || a.status === 'initialized' ? (
                          <Link
                            href={`/portal/payments/return?reference=${encodeURIComponent(a.reference)}`}
                            className="text-sm text-primary underline"
                          >
                            Verify now
                          </Link>
                        ) : a.failureReason ? (
                          <span className="text-xs text-fg-muted">{a.failureReason}</span>
                        ) : (
                          <span className="text-fg-muted">—</span>
                        ),
                    },
                  ]}
                />
              )}
              {bankReceipts.length > 0 ? (
                <DataTable
                  caption="Bank transfer declarations"
                  rows={bankReceipts}
                  rowKey={(r) => r.id}
                  rowLabel={(r) => `Bank transfer ${r.bankReference ?? r.id.slice(0, 8)}`}
                  columns={[
                    { key: 'ref', header: 'Bank reference', cell: (r) => r.bankReference ?? '—' },
                    {
                      key: 'amount',
                      header: 'Declared',
                      cell: (r) => koboToNaira(r.declaredAmountKobo),
                      className: 'text-right',
                    },
                    {
                      key: 'paid',
                      header: 'Date paid',
                      cell: (r) => r.declaredPaidAt ?? '—',
                      hideOnMobile: true,
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      cell: (r) => (
                        <StatusBadge
                          status={r.status}
                          label={
                            r.status === 'submitted'
                              ? 'Declared, awaiting finance'
                              : humanize(r.status)
                          }
                        />
                      ),
                    },
                    {
                      key: 'note',
                      header: 'Finance note',
                      cell: (r) => r.reviewNote ?? '—',
                      hideOnMobile: true,
                    },
                    {
                      key: 'proof',
                      header: 'Proof',
                      cell: (r) =>
                        r.uploadedFileId ? (
                          <SignedDownloadButton
                            fileId={r.uploadedFileId}
                            fileName="proof of transfer"
                            status="clean"
                          />
                        ) : (
                          <span className="text-fg-muted">None</span>
                        ),
                    },
                  ]}
                />
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Receipts</CardTitle>
              <CardDescription>Issued once money is verified.</CardDescription>
            </CardHeader>
            <CardContent>
              {receipts.length === 0 ? (
                <p className="text-sm text-fg-muted">No receipts yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {receipts.map((r) => (
                    <li key={r.id} className="rounded-md border border-border p-3">
                      <p className="flex flex-wrap items-center justify-between gap-2">
                        <code className="font-mono">{r.number}</code>
                        <Badge tone="success">{humanize(r.source)}</Badge>
                      </p>
                      <p className="mt-1">
                        {koboToNaira(r.amountKobo)} {r.currency}
                      </p>
                      <p className="text-xs text-fg-muted">
                        {formatDateTimeLabel(r.issuedAt, zone)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Related</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {invoice.serviceRequestId ? (
                <p>
                  <Link
                    href={`/portal/requests/${invoice.serviceRequestId}`}
                    className="text-primary underline"
                  >
                    Open the service request
                  </Link>
                </p>
              ) : (
                <p className="text-fg-muted">Not linked to a request.</p>
              )}
              <p className="text-fg-muted">
                Invoice version {invoice.version} ·{' '}
                {invoice.taxTreatmentKey
                  ? `tax treatment ${humanize(invoice.taxTreatmentKey)}`
                  : 'default tax treatment'}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
