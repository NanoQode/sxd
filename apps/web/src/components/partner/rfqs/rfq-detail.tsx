'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { RfqDetail, RfqResponseDto, RfqResponseSubmit } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  PageHeader,
  StatusBadge,
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, useServerNow } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { koboToNairaInput, nairaInputToKobo } from '@/lib/partner/money';
import { DeadlineCountdown, DetailList, DualTime, LoadingBlock, RequestFailed } from '../common';

interface LineForm {
  itemId: string;
  unitPriceNaira: string;
  quantityUnit: string;
  convFactor: string;
  leadTimeDays: string;
  note: string;
}

export function RfqDetailView({ rfqId }: { rfqId: string }) {
  const p = usePartner();
  const { now } = useServerNow();
  const rfq = useQuery({
    queryKey: ['partner', 'rfq', rfqId],
    queryFn: () => partnerFetch<RfqDetail>(`/api/v1/rfqs/${rfqId}`),
  });
  if (rfq.isPending) return <LoadingBlock rows={5} label="Loading RFQ" />;
  if (rfq.isError)
    return <RequestFailed error={rfq.error} onRetry={() => void rfq.refetch()} context="RFQ" />;
  const r = rfq.data;
  const mine = r.responses.find((x) => x.supplierUserId === p.userId) ?? null;
  const deadlinePassed = r.deadlineAt ? new Date(r.deadlineAt).getTime() <= now.getTime() : false;
  // Withdrawn, selected and rejected responses are final on the server.
  const canRespond =
    r.status === 'sent' &&
    !deadlinePassed &&
    (!mine || ['draft', 'submitted'].includes(mine.status));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/partner/rfqs" className="underline">
            RFQs & orders
          </Link>
        }
        title={r.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{r.reference}</span>
            <StatusBadge status={r.status} />
            {mine ? <Badge tone="info">My response: {humanize(mine.status)}</Badge> : null}
          </span>
        }
        actions={r.status === 'sent' ? <DeadlineCountdown deadlineIso={r.deadlineAt} /> : null}
      />
      <Card>
        <CardContent className="pt-5">
          <DetailList
            items={[
              { label: 'Deadline', value: <DualTime iso={r.deadlineAt} zone={p.timeZone} /> },
              { label: 'Deliver to', value: r.deliveryMarketName ?? '—' },
              {
                label: 'Delivery address',
                value: r.deliveryAddress
                  ? Object.values(r.deliveryAddress).filter(Boolean).join(', ')
                  : '—',
              },
              { label: 'Notes from buyer', value: r.notes ?? '—' },
            ]}
          />
        </CardContent>
      </Card>
      {mine?.status === 'selected' ? (
        <Alert tone="success" title="Your quotation was selected">
          Expect a purchase order under RFQs & orders → Purchase orders.
        </Alert>
      ) : null}
      {mine?.status === 'rejected' ? (
        <Alert tone="info" title="Your quotation was not selected">
          Other suppliers&apos; prices are not disclosed.
        </Alert>
      ) : null}
      <RfqResponseForm
        key={`${mine?.id ?? 'none'}:${mine?.updatedAt ?? ''}`}
        rfq={r}
        mine={mine}
        canRespond={canRespond}
        deadlinePassed={deadlinePassed}
        zone={p.timeZone}
      />
    </div>
  );
}

function seedLines(rfq: RfqDetail, mine: RfqResponseDto | null): LineForm[] {
  return rfq.items.map((it) => {
    const l = mine?.lines.find((x) => x.itemId === it.id);
    return {
      itemId: it.id,
      unitPriceNaira: koboToNairaInput(l?.unitPriceKobo ?? null),
      quantityUnit: l?.quantityUnit ?? it.unit,
      convFactor: l?.declaredConversion?.factor ?? '',
      leadTimeDays: l?.leadTimeDays?.toString() ?? '',
      note: l?.note ?? '',
    };
  });
}

/** Keyed on the current response so it re-seeds when the server copy changes. */
function RfqResponseForm({
  rfq: r,
  mine,
  canRespond,
  deadlinePassed,
  zone,
}: {
  rfq: RfqDetail;
  mine: RfqResponseDto | null;
  canRespond: boolean;
  deadlinePassed: boolean;
  zone: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const rfqId = r.id;
  const [lines, setLines] = useState<LineForm[]>(() => seedLines(r, mine));
  const [deliveryNaira, setDeliveryNaira] = useState(() =>
    koboToNairaInput(mine?.deliveryKobo ?? null),
  );
  const [leadTime, setLeadTime] = useState(() => mine?.leadTimeDays?.toString() ?? '');
  const [validUntil, setValidUntil] = useState(() =>
    mine?.validUntil ? mine.validUntil.slice(0, 16) : '',
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const submit = useMutation({
    mutationFn: (input: RfqResponseSubmit) =>
      partnerFetch<RfqResponseDto>(`/api/v1/rfqs/${rfqId}/responses`, { body: input }),
    onSuccess: (_r, input) => {
      toast({
        tone: 'success',
        title: input.submit ? 'Quotation submitted' : 'Quotation saved as draft',
      });
      void qc.invalidateQueries({ queryKey: ['partner', 'rfq', rfqId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'rfqs'] });
    },
  });
  const withdraw = useMutation({
    mutationFn: () =>
      partnerFetch(`/api/v1/rfqs/${rfqId}/responses/${mine?.id}/withdraw`, { body: {} }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Quotation withdrawn' });
      setConfirmWithdraw(false);
      void qc.invalidateQueries({ queryKey: ['partner', 'rfq', rfqId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'rfqs'] });
    },
  });

  function setLine(i: number, patch: Partial<LineForm>) {
    setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  function build(doSubmit: boolean): RfqResponseSubmit | null {
    const errs: string[] = [];
    const out: RfqResponseSubmit['lines'] = [];
    r.items.forEach((it, i) => {
      const l = lines[i]!;
      const price = nairaInputToKobo(l.unitPriceNaira);
      if (price === null)
        errs.push(`Item ${i + 1} (${it.specification}): enter a unit price in naira`);
      const unit = l.quantityUnit.trim() || it.unit;
      const differs = unit.toLowerCase() !== it.unit.toLowerCase();
      let declaredConversion: RfqResponseSubmit['lines'][number]['declaredConversion'] = null;
      if (differs) {
        if (!/^\d+(\.\d{1,6})?$/.test(l.convFactor.trim()) || Number(l.convFactor) <= 0) {
          errs.push(
            `Item ${i + 1}: you price per "${unit}" but the RFQ asks per "${it.unit}"; declare how many ${it.unit} one ${unit} contains`,
          );
        } else {
          declaredConversion = {
            fromUnit: unit,
            toUnit: it.unit,
            factor: l.convFactor.trim(),
            basis: 'supplier_declared',
          };
        }
      }
      const lead = l.leadTimeDays.trim() ? Number(l.leadTimeDays) : null;
      if (lead !== null && (!Number.isInteger(lead) || lead < 0))
        errs.push(`Item ${i + 1}: lead time must be whole days`);
      if (price !== null) {
        out.push({
          itemId: it.id,
          unitPriceKobo: price,
          quantityUnit: unit,
          declaredConversion,
          leadTimeDays: lead,
          note: l.note.trim() || null,
        });
      }
    });
    const delivery = nairaInputToKobo(deliveryNaira || '0');
    if (delivery === null) errs.push('Delivery charge must be a naira amount (0 if included)');
    const overallLead = leadTime.trim() ? Number(leadTime) : null;
    if (overallLead !== null && (!Number.isInteger(overallLead) || overallLead < 0))
      errs.push('Overall lead time must be whole days');
    let valid: string | null = null;
    if (validUntil.trim()) {
      const d = new Date(validUntil);
      if (Number.isNaN(d.getTime())) errs.push('Valid-until must be a date and time');
      else valid = d.toISOString();
    }
    setErrors(errs);
    if (errs.length > 0 || delivery === null) return null;
    return {
      currency: 'NGN',
      lines: out,
      deliveryKobo: delivery,
      leadTimeDays: overallLead,
      validUntil: valid,
      submit: doSubmit,
    };
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const input = build(true);
        if (input) submit.mutate(input);
      }}
      className="space-y-6"
    >
      {errors.length > 0 ? (
        <div role="alert" className="rounded-md border border-danger bg-danger-soft p-3 text-sm">
          <p className="font-medium">Please fix the following</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {submit.isError ? (
        <Alert tone="danger" title="Could not send the quotation">
          {errorMessage(submit.error)}
        </Alert>
      ) : null}
      <fieldset disabled={!canRespond} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Priced items</CardTitle>
            <p className="text-xs text-fg-muted">
              Price per your own unit. When your unit differs from the RFQ unit, declare the
              conversion factor; it is recorded as supplier-declared and staff may re-measure.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {r.items.map((it, i) => {
              const l = lines[i];
              if (!l) return null;
              const differs =
                (l.quantityUnit.trim() || it.unit).toLowerCase() !== it.unit.toLowerCase();
              return (
                <fieldset
                  key={it.id}
                  className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-6"
                >
                  <legend className="px-1 text-sm font-medium">
                    {humanize(it.material)} · {it.specification} · {it.quantity} {it.unit}
                  </legend>
                  <Field
                    label="Unit price (₦)"
                    htmlFor={`rfq-${it.id}-price`}
                    className="sm:col-span-2"
                    required
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.unitPriceNaira}
                        onChange={(e) => setLine(i, { unitPriceNaira: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label="Per unit"
                    htmlFor={`rfq-${it.id}-unit`}
                    className="sm:col-span-1"
                    hint={`RFQ unit: ${it.unit}`}
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        value={l.quantityUnit}
                        maxLength={32}
                        onChange={(e) => setLine(i, { quantityUnit: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label={`1 ${l.quantityUnit.trim() || it.unit} = ? ${it.unit}`}
                    htmlFor={`rfq-${it.id}-factor`}
                    className="sm:col-span-1"
                    hint={
                      differs
                        ? 'Required: supplier-declared conversion'
                        : 'Same unit; no conversion'
                    }
                    required={differs}
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        inputMode="decimal"
                        disabled={!differs}
                        value={l.convFactor}
                        onChange={(e) => setLine(i, { convFactor: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label="Lead time (days)"
                    htmlFor={`rfq-${it.id}-lead`}
                    className="sm:col-span-1"
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="numeric"
                        value={l.leadTimeDays}
                        onChange={(e) => setLine(i, { leadTimeDays: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Note" htmlFor={`rfq-${it.id}-note`} className="sm:col-span-1">
                    {({ id }) => (
                      <Input
                        id={id}
                        maxLength={1000}
                        value={l.note}
                        onChange={(e) => setLine(i, { note: e.target.value })}
                      />
                    )}
                  </Field>
                </fieldset>
              );
            })}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Delivery and validity</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Delivery charge (₦)"
              htmlFor="rfq-delivery"
              hint="0 when included in prices."
              required
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  value={deliveryNaira}
                  onChange={(e) => setDeliveryNaira(e.target.value)}
                />
              )}
            </Field>
            <Field label="Overall lead time (days)" htmlFor="rfq-lead">
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  value={leadTime}
                  onChange={(e) => setLeadTime(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Prices valid until"
              htmlFor="rfq-valid"
              hint="Your local time; stored in UTC."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="datetime-local"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              )}
            </Field>
          </CardContent>
        </Card>
      </fieldset>
      {mine ? (
        <p className="text-sm text-fg-muted">
          Current response total{' '}
          {mine.totalDeliveredKobo
            ? formatNairaString(mine.totalDeliveredKobo)
            : 'unknown (a declared conversion is missing)'}
          ; submitted <DualTime iso={mine.submittedAt} zone={zone} />
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={!canRespond}
          loading={submit.isPending && submit.variables?.submit === false}
          onClick={() => {
            const input = build(false);
            if (input) submit.mutate(input);
          }}
        >
          Save draft
        </Button>
        <Button
          type="submit"
          disabled={!canRespond}
          loading={submit.isPending && submit.variables?.submit === true}
        >
          {mine?.status === 'submitted' ? 'Re-submit quotation' : 'Submit quotation'}
        </Button>
        {mine && canRespond ? (
          <Button type="button" variant="danger" onClick={() => setConfirmWithdraw(true)}>
            Withdraw
          </Button>
        ) : null}
      </div>
      {!canRespond ? (
        <Alert
          tone="info"
          title={
            mine && !['draft', 'submitted'].includes(mine.status)
              ? `Your response is ${humanize(mine.status).toLowerCase()}`
              : deadlinePassed
                ? 'Deadline passed'
                : `RFQ is ${humanize(r.status).toLowerCase()}`
          }
        >
          {mine?.status === 'withdrawn'
            ? 'A withdrawn quotation is final and cannot be changed or resubmitted.'
            : 'Responses are no longer accepted for this request.'}
        </Alert>
      ) : null}
      <Dialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
        <DialogContent
          title="Withdraw your quotation?"
          description="Withdrawal is final: the buyer no longer considers it and you cannot resubmit for this RFQ."
        >
          {withdraw.isError ? (
            <Alert tone="danger" title="Could not withdraw">
              {errorMessage(withdraw.error)}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmWithdraw(false)}>
              Keep quotation
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={withdraw.isPending}
              onClick={() => withdraw.mutate()}
            >
              Withdraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
