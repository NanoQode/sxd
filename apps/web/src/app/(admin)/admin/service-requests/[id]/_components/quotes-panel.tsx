'use client';

import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { QuoteDto, QuoteLineInput } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { koboToNairaInput, lineAmountKobo, parseNairaToKobo, sumKobo } from '@/lib/admin/money';
import type { QuoteTemplateOption } from '@/lib/admin/server/service-requests';
import { ApiAction } from '@/components/admin/api-action';
import { Money } from '@/components/admin/money';

interface DraftLine {
  description: string;
  quantity: string;
  unitNaira: string;
}

const EMPTY_LINE: DraftLine = { description: '', quantity: '1', unitNaira: '' };

export function QuotesPanel({
  requestId,
  status,
  quotes,
  templates,
  taxTreatments,
  canQuote,
}: {
  requestId: string;
  status: string;
  quotes: QuoteDto[];
  templates: QuoteTemplateOption[];
  taxTreatments: Array<{ key: string; name: string; rateBps: number }>;
  canQuote: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  /** Template whose lines were copied into the form; sent as provenance only. */
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [scope, setScope] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [taxKey, setTaxKey] = useState('');
  const [depositPct, setDepositPct] = useState('100');
  const [requiresPayment, setRequiresPayment] = useState(true);
  const [validDays, setValidDays] = useState('14');
  const [target, setTarget] = useState<QuoteDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDraft = canQuote && ['triage', 'quoted'].includes(status);
  const parsedLines = useMemo(
    () =>
      lines.map((l) => {
        const unit = parseNairaToKobo(l.unitNaira);
        const qtyOk = /^\d+(\.\d{1,3})?$/.test(l.quantity);
        return {
          ...l,
          unitKobo: unit,
          qtyOk,
          amountKobo: unit && qtyOk ? lineAmountKobo(l.quantity, unit) : null,
        };
      }),
    [lines],
  );
  const subtotal = sumKobo(parsedLines.map((l) => l.amountKobo));
  const linesValid =
    parsedLines.length > 0 &&
    parsedLines.every((l) => l.description.trim() && l.unitKobo && l.qtyOk);
  const ready = linesValid;

  /** Copies the template's lines, scope and exclusions into the form; everything stays editable. */
  function applyTemplate() {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    setLines(
      t.lines.length > 0
        ? t.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitNaira: koboToNairaInput(l.unitAmountKobo),
          }))
        : [{ ...EMPTY_LINE }],
    );
    setScope(t.scopeMarkdown ?? '');
    setExclusions(t.exclusions ?? '');
    setAppliedTemplateId(t.id);
  }

  function openNew(existing: QuoteDto | null) {
    setTarget(existing);
    setError(null);
    setAppliedTemplateId(null);
    if (existing) {
      const v = existing.versions[existing.versions.length - 1];
      setLines(
        v
          ? v.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitNaira: koboToNairaInput(l.unitAmountKobo),
            }))
          : [{ ...EMPTY_LINE }],
      );
      setScope(v?.scopeMarkdown ?? '');
      setExclusions(v?.exclusions ?? '');
      setTaxKey(v?.taxTreatmentKey ?? '');
    }
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const lineInputs: QuoteLineInput[] = parsedLines.map((l) => ({
      description: l.description.trim(),
      quantity: l.quantity,
      unitAmountKobo: l.unitKobo!,
    }));
    const base = {
      scopeMarkdown: scope.trim() || undefined,
      exclusions: exclusions.trim() || undefined,
      taxTreatmentKey: taxKey || undefined,
      depositBps: Math.round(Number(depositPct) * 100),
      requiresPayment,
    };
    try {
      if (target) {
        await adminFetch(`/api/v1/quotes/${target.id}/versions`, {
          body: { lines: lineInputs, ...base },
        });
        toast({ title: 'New quote version drafted', tone: 'success' });
      } else {
        await adminFetch(`/api/v1/service-requests/${requestId}/quotes`, {
          body: {
            lines: lineInputs,
            ...(appliedTemplateId ? { templateId: appliedTemplateId } : {}),
            ...base,
          },
        });
        toast({
          title: 'Quote drafted',
          description: 'Issue it to send it to the customer.',
          tone: 'success',
        });
      }
      setOpen(false);
      setLines([{ ...EMPTY_LINE }]);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {quotes.length === 0 ? (
        <p className="text-fg-muted">
          No quote yet.{' '}
          {status === 'inquiry'
            ? 'Triage the request first; quotes can only be drafted from triage.'
            : canDraft
              ? 'Draft one from a template or from lines.'
              : ''}
        </p>
      ) : (
        <ul className="space-y-3">
          {quotes.map((q) => {
            const latest = q.versions[q.versions.length - 1];
            return (
              <li key={q.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">Quote v{q.currentVersion}</span>{' '}
                    <StatusBadge status={q.status === 'issued' ? 'issued' : q.status} />
                    {latest?.validUntil ? (
                      <span className="ml-2 text-xs text-fg-muted">
                        valid until {formatDateTimeLabel(latest.validUntil)}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canQuote && q.status === 'draft' ? (
                      <ApiAction
                        path={`/api/v1/quotes/${q.id}/issue`}
                        label="Issue to customer"
                        variant="primary"
                        body={{ validDays: Number(validDays) || 14 }}
                        confirm={{
                          title: 'Issue this quote?',
                          description: `The customer receives version ${q.currentVersion} and can accept or reject it. The request moves to quoted.`,
                          confirmLabel: 'Issue quote',
                          children: (
                            <Field label="Valid for (days)">
                              {({ id }) => (
                                <Input
                                  id={id}
                                  type="number"
                                  min={1}
                                  max={180}
                                  value={validDays}
                                  onChange={(e) => setValidDays(e.target.value)}
                                />
                              )}
                            </Field>
                          ),
                        }}
                        successMessage="Quote issued"
                      />
                    ) : null}
                    {canDraft && ['draft', 'issued', 'rejected', 'expired'].includes(q.status) ? (
                      <Button variant="secondary" size="sm" onClick={() => openNew(q)}>
                        New version
                      </Button>
                    ) : null}
                  </div>
                </div>
                {q.acceptance ? (
                  <p className="mt-1 text-xs text-success">
                    Accepted by {q.acceptance.signatureName} on{' '}
                    {formatDateTimeLabel(q.acceptance.acceptedAt)} (terms{' '}
                    {q.acceptance.termsVersion})
                  </p>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-fg-muted">
                    {q.versions.length} version{q.versions.length === 1 ? '' : 's'} · latest total{' '}
                    <Money kobo={latest?.totalKobo} currency={latest?.currency} />
                  </summary>
                  <div className="mt-2 space-y-3">
                    {[...q.versions].reverse().map((v) => (
                      <div key={v.id} className="rounded-md bg-bg-sunken p-2 text-sm">
                        <p className="font-medium">
                          Version {v.version}{' '}
                          <span className="text-xs text-fg-muted">
                            {v.issuedAt
                              ? `issued ${formatDateTimeLabel(v.issuedAt)}`
                              : 'not issued'}
                          </span>
                        </p>
                        <table className="mt-1 w-full text-xs">
                          <thead className="text-fg-muted">
                            <tr>
                              <th className="text-left font-medium">Line</th>
                              <th className="text-right font-medium">Qty</th>
                              <th className="text-right font-medium">Unit</th>
                              <th className="text-right font-medium">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {v.lines.map((l, i) => (
                              <tr key={i}>
                                <td>{l.description}</td>
                                <td className="text-right">{l.quantity}</td>
                                <td className="text-right">
                                  <Money kobo={l.unitAmountKobo} />
                                </td>
                                <td className="text-right">
                                  <Money kobo={l.amountKobo} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td colSpan={3} className="text-right text-fg-muted">
                                Subtotal
                              </td>
                              <td className="text-right">
                                <Money kobo={v.subtotalKobo} />
                              </td>
                            </tr>
                            <tr>
                              <td colSpan={3} className="text-right text-fg-muted">
                                Tax{v.taxTreatmentKey ? ` (${v.taxTreatmentKey})` : ''}
                              </td>
                              <td className="text-right">
                                <Money kobo={v.taxKobo} />
                              </td>
                            </tr>
                            <tr className="font-medium">
                              <td colSpan={3} className="text-right">
                                Total
                              </td>
                              <td className="text-right">
                                <Money kobo={v.totalKobo} currency={v.currency} />
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                        {v.scopeMarkdown ? (
                          <p className="mt-2 whitespace-pre-wrap">
                            <strong>Scope:</strong> {v.scopeMarkdown}
                          </p>
                        ) : null}
                        {v.exclusions ? (
                          <p className="mt-1 whitespace-pre-wrap">
                            <strong>Exclusions:</strong> {v.exclusions}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {canDraft ? (
        <Button
          size="sm"
          variant={quotes.length === 0 ? 'primary' : 'secondary'}
          onClick={() => openNew(null)}
        >
          Draft a quote
        </Button>
      ) : canQuote && !['triage', 'quoted'].includes(status) && status !== 'inquiry' ? (
        <p className="text-xs text-fg-muted">
          Quotes can only be drafted while the request is in triage or quoted.
        </p>
      ) : null}

      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title={target ? `New version of quote v${target.currentVersion}` : 'Draft a quote'}
          description="Amounts are whole naira; the server recomputes every line, tax and total from what it stores."
          size="lg"
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            {templates.length > 0 ? (
              <div className="rounded-md border border-border bg-bg-sunken p-3">
                <Field
                  label="Start from a quotation template"
                  hint="Copies the template's lines, scope and exclusions into the form below, where you can change them. The issued quote is its own versioned record; later template edits never touch it."
                >
                  {({ id }) => (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <NativeSelect
                        id={id}
                        value={templateId}
                        onChange={(e) => setTemplateId(e.target.value)}
                        className="sm:flex-1"
                      >
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.lineCount} {t.lineCount === 1 ? 'line' : 'lines'}
                            {t.global ? ', all services' : ''})
                          </option>
                        ))}
                      </NativeSelect>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={applyTemplate}
                        disabled={!templateId}
                      >
                        Use template
                      </Button>
                    </div>
                  )}
                </Field>
                {appliedTemplateId ? (
                  <p className="mt-2 text-xs text-fg-muted">
                    Lines copied from “
                    {templates.find((t) => t.id === appliedTemplateId)?.name ?? 'template'}”. Edit
                    anything before saving.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-fg-muted">
                No active quotation template applies to this service. Templates are managed
                under Services → Quote templates.
              </p>
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium">Lines</p>
                {lines.map((l, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[3fr_1fr_1.5fr_auto]">
                    <Input
                      aria-label={`Line ${i + 1} description`}
                      placeholder="Description"
                      value={l.description}
                      onChange={(e) =>
                        setLines(
                          lines.map((x, j) =>
                            j === i ? { ...x, description: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <Input
                      aria-label={`Line ${i + 1} quantity`}
                      placeholder="Qty"
                      value={l.quantity}
                      onChange={(e) =>
                        setLines(
                          lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                        )
                      }
                    />
                    <Input
                      aria-label={`Line ${i + 1} unit amount in naira`}
                      placeholder="Unit ₦"
                      inputMode="decimal"
                      value={l.unitNaira}
                      onChange={(e) =>
                        setLines(
                          lines.map((x, j) => (j === i ? { ...x, unitNaira: e.target.value } : x)),
                        )
                      }
                      aria-invalid={l.unitNaira !== '' && !parsedLines[i]?.unitKobo}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove line ${i + 1}`}
                      disabled={lines.length === 1}
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
                  >
                    Add line
                  </Button>
                  <span className="text-sm">
                    Subtotal (before tax): <Money kobo={subtotal} />
                  </span>
                </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Tax treatment" hint="Reviewed treatments only; none means no tax line.">
                {({ id }) => (
                  <NativeSelect id={id} value={taxKey} onChange={(e) => setTaxKey(e.target.value)}>
                    <option value="">Default for service</option>
                    {taxTreatments.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name} ({(t.rateBps / 100).toFixed(2)}%)
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Deposit % on acceptance">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={100}
                    value={depositPct}
                    onChange={(e) => setDepositPct(e.target.value)}
                    disabled={!requiresPayment}
                  />
                )}
              </Field>
              <label className="flex h-full items-end gap-2 pb-3 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={requiresPayment}
                  onChange={(e) => setRequiresPayment(e.target.checked)}
                />
                Requires payment before work
              </label>
            </div>
            <Field label="Scope (markdown)">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="min-h-20"
                  maxLength={20000}
                />
              )}
            </Field>
            <Field label="Exclusions">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={exclusions}
                  onChange={(e) => setExclusions(e.target.value)}
                  className="min-h-16"
                  maxLength={8000}
                />
              )}
            </Field>
            <p className="text-xs text-fg-muted">
              {humanize('deposit')} {depositPct}% ·{' '}
              {requiresPayment ? 'invoice issued on acceptance' : 'no upfront invoice'}{' '}
              <Badge tone="neutral">draft only; issue separately</Badge>
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ready} onClick={() => void submit()}>
                {target ? 'Save new version' : 'Save draft'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
