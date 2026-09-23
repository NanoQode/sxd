import Link from 'next/link';
import type { QuoteDto, QuoteVersionDto } from '@simplexd/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { koboToNaira } from '@/lib/portal/format';
import { QuoteActions } from './quote-actions';

export function currentQuoteVersion(quote: QuoteDto): QuoteVersionDto | null {
  return (
    quote.versions.find((v) => v.version === quote.currentVersion) ??
    quote.versions[quote.versions.length - 1] ??
    null
  );
}

/** Quote lines and totals for one version. Money is server-computed integer kobo. */
export function QuoteVersionTable({ version }: { version: QuoteVersionDto }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[480px] text-sm">
        <caption className="sr-only">Quote version {version.version} lines</caption>
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
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {version.lines.map((l, i) => (
            <tr key={`${l.description}-${i}`} className="border-t border-border">
              <td className="px-3 py-2">{l.description}</td>
              <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
              <td className="px-3 py-2 text-right tabular-nums">{koboToNaira(l.unitAmountKobo)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{koboToNaira(l.amountKobo)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border text-sm">
          <tr>
            <th
              scope="row"
              colSpan={3}
              className="px-3 py-1.5 text-right font-normal text-fg-muted"
            >
              Subtotal
            </th>
            <td className="px-3 py-1.5 text-right tabular-nums">
              {koboToNaira(version.subtotalKobo)}
            </td>
          </tr>
          <tr>
            <th
              scope="row"
              colSpan={3}
              className="px-3 py-1.5 text-right font-normal text-fg-muted"
            >
              Tax{version.taxTreatmentKey ? ` (${humanize(version.taxTreatmentKey)})` : ''}
            </th>
            <td className="px-3 py-1.5 text-right tabular-nums">{koboToNaira(version.taxKobo)}</td>
          </tr>
          <tr className="font-semibold">
            <th scope="row" colSpan={3} className="px-3 py-2 text-right">
              Total ({version.currency})
            </th>
            <td className="px-3 py-2 text-right tabular-nums">{koboToNaira(version.totalKobo)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** One quote with its version history and the customer's accept/reject actions. */
export function QuoteCard({
  quote,
  zone,
  canAccept,
  cannotAcceptReason,
  requestHref,
  detailHref,
  compact = false,
}: {
  quote: QuoteDto;
  zone: string;
  canAccept: boolean;
  cannotAcceptReason?: string;
  requestHref?: string;
  detailHref?: string;
  compact?: boolean;
}) {
  const current = currentQuoteVersion(quote);
  const older = quote.versions
    .filter((v) => v.id !== current?.id)
    .sort((a, b) => b.version - a.version);
  const expired = Boolean(current?.validUntil && new Date(current.validUntil) < new Date());
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {detailHref ? (
              <Link href={detailHref} className="underline">
                Quote v{quote.currentVersion}
              </Link>
            ) : (
              <>Quote v{quote.currentVersion}</>
            )}
            <StatusBadge status={quote.status} />
            {quote.status === 'issued' && expired ? (
              <Badge tone="warning">Validity passed</Badge>
            ) : null}
          </CardTitle>
          {current ? (
            <p className="font-display text-xl font-semibold">{koboToNaira(current.totalKobo)}</p>
          ) : null}
        </div>
        <CardDescription>
          {current?.issuedAt
            ? `Issued ${formatDateTimeLabel(current.issuedAt, zone)}`
            : 'Not issued yet'}
          {current?.validUntil
            ? ` · valid until ${formatDateTimeLabel(current.validUntil, zone)}`
            : ''}
          {quote.acceptance
            ? ` · accepted by ${quote.acceptance.signatureName} on ${formatDateTimeLabel(quote.acceptance.acceptedAt, zone)} (terms ${quote.acceptance.termsVersion})`
            : ''}
          {requestHref ? (
            <>
              {' · '}
              <Link href={requestHref} className="underline">
                Open request
              </Link>
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {current ? (
          <>
            {!compact && current.scopeMarkdown ? (
              <div>
                <h3 className="mb-1 text-sm font-medium">Scope</h3>
                <p className="whitespace-pre-wrap text-sm text-fg-muted">{current.scopeMarkdown}</p>
              </div>
            ) : null}
            {!compact && current.exclusions ? (
              <div>
                <h3 className="mb-1 text-sm font-medium">Exclusions</h3>
                <p className="whitespace-pre-wrap text-sm text-fg-muted">{current.exclusions}</p>
              </div>
            ) : null}
            <QuoteVersionTable version={current} />
            {quote.status === 'issued' ? (
              <QuoteActions
                quoteId={quote.id}
                versionId={current.id}
                versionNumber={current.version}
                totalLabel={koboToNaira(current.totalKobo)}
                canAccept={canAccept && !expired}
                cannotAcceptReason={
                  expired
                    ? 'This quote passed its validity date; ask the team to re-issue it.'
                    : cannotAcceptReason
                }
              />
            ) : null}
            {quote.invoiceId ? (
              <p className="text-sm">
                <Link
                  href={`/portal/invoices/${quote.invoiceId}`}
                  className="font-medium text-primary underline"
                >
                  Open the invoice raised on acceptance
                </Link>
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-fg-muted">This quote has no version yet.</p>
        )}
        {older.length > 0 ? (
          <details className="rounded-md border border-border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              {older.length} earlier version{older.length === 1 ? '' : 's'} (superseded)
            </summary>
            <div className="mt-3 space-y-4">
              {older.map((v) => (
                <div key={v.id} className="space-y-2">
                  <p className="text-xs text-fg-muted">
                    Version {v.version} ·{' '}
                    {v.issuedAt
                      ? `issued ${formatDateTimeLabel(v.issuedAt, zone)}`
                      : 'never issued'}{' '}
                    · total {koboToNaira(v.totalKobo)}
                  </p>
                  <QuoteVersionTable version={v} />
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
