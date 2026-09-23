'use client';

import { Field, Input, NativeSelect, Textarea } from '@simplexd/ui';
import { koboToNairaInput, parseNairaToKobo } from '@/lib/admin/money';
import { basisLabel, type PriceBasis } from '@/components/public/price-anchor';
import type { AnchorValues } from '@/lib/services/price-anchors';

/** Form state for a price anchor; money is typed in naira and sent as integer kobo. */
export interface AnchorFormState {
  name: string;
  description: string;
  scopeMarkdown: string;
  priceBasis: PriceBasis;
  amountNaira: string;
  percent: string;
  minimumScope: string;
  exclusions: string;
  effectiveFrom: string;
  effectiveTo: string;
}

export const BASES: PriceBasis[] = ['from', 'fixed', 'per_month', 'percentage', 'quotation'];

export function formFromValues(v: AnchorValues | null, today: string): AnchorFormState {
  return {
    name: v?.name ?? '',
    description: v?.description ?? '',
    scopeMarkdown: v?.scopeMarkdown ?? '',
    priceBasis: v?.priceBasis ?? 'from',
    amountNaira: koboToNairaInput(v?.amountKobo),
    percent:
      v?.percentageBps === null || v?.percentageBps === undefined
        ? ''
        : String(v.percentageBps / 100),
    minimumScope: v?.minimumScope ?? '',
    exclusions: v?.exclusions ?? '',
    effectiveFrom: v?.effectiveFrom ?? today,
    effectiveTo: v?.effectiveTo ?? '',
  };
}

const hasAmount = (b: PriceBasis) => b === 'fixed' || b === 'from' || b === 'per_month';

/** Converts the form to the API payload, or returns the first client-side problem. */
export function payloadFromForm(f: AnchorFormState): {
  values?: Record<string, unknown>;
  error?: string;
} {
  const amountKobo = hasAmount(f.priceBasis) ? parseNairaToKobo(f.amountNaira) : null;
  if (hasAmount(f.priceBasis) && (!amountKobo || amountKobo.startsWith('-') || amountKobo === '0'))
    return { error: 'Enter the amount in naira (whole naira or naira.kobo).' };
  let percentageBps: number | null = null;
  if (f.priceBasis === 'percentage') {
    if (!/^\d+(\.\d{1,2})?$/.test(f.percent.trim()))
      return { error: 'Enter the percentage with up to two decimals, e.g. 1.5.' };
    percentageBps = Math.round(Number(f.percent) * 100);
    if (percentageBps < 1 || percentageBps > 10_000)
      return { error: 'The percentage must be between 0.01% and 100%.' };
  }
  if (!f.effectiveFrom) return { error: 'Choose the date the anchor takes effect.' };
  return {
    values: {
      name: f.name.trim(),
      description: f.description.trim() || null,
      scopeMarkdown: f.scopeMarkdown.trim() || null,
      priceBasis: f.priceBasis,
      amountKobo,
      percentageBps,
      currency: 'NGN',
      minimumScope: f.minimumScope.trim(),
      exclusions: f.exclusions.trim(),
      effectiveFrom: f.effectiveFrom,
      effectiveTo: f.effectiveTo || null,
    },
  };
}

export function AnchorForm({
  value,
  onChange,
}: {
  value: AnchorFormState;
  onChange: (next: AnchorFormState) => void;
}) {
  const set = <K extends keyof AnchorFormState>(key: K, v: AnchorFormState[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Package name" required className="sm:col-span-2">
        {({ id }) => (
          <Input
            id={id}
            value={value.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={120}
          />
        )}
      </Field>
      <Field label="Price basis" required>
        {({ id }) => (
          <NativeSelect
            id={id}
            value={value.priceBasis}
            onChange={(e) => set('priceBasis', e.target.value as PriceBasis)}
          >
            {BASES.map((b) => (
              <option key={b} value={b}>
                {basisLabel(b)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {hasAmount(value.priceBasis) ? (
        <Field
          label={value.priceBasis === 'per_month' ? 'Amount per month (₦)' : 'Amount (₦)'}
          required
          hint="Whole naira; stored as integer kobo."
        >
          {({ id }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={value.amountNaira}
              onChange={(e) => set('amountNaira', e.target.value)}
            />
          )}
        </Field>
      ) : value.priceBasis === 'percentage' ? (
        <Field
          label="Percentage of purchase price (%)"
          required
          hint="Stored in basis points (1.5% = 150). Never invoiced without an agreed basis and signed scope."
        >
          {({ id }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={value.percent}
              onChange={(e) => set('percent', e.target.value)}
            />
          )}
        </Field>
      ) : (
        <p className="self-end pb-3 text-sm text-fg-muted">
          Priced by quotation; no figure is shown.
        </p>
      )}
      <Field
        label="Minimum scope"
        required
        className="sm:col-span-2"
        hint="What the anchor covers at minimum."
      >
        {({ id }) => (
          <Textarea
            id={id}
            value={value.minimumScope}
            onChange={(e) => set('minimumScope', e.target.value)}
            className="min-h-16"
            maxLength={2000}
          />
        )}
      </Field>
      <Field label="Exclusions" required className="sm:col-span-2">
        {({ id }) => (
          <Textarea
            id={id}
            value={value.exclusions}
            onChange={(e) => set('exclusions', e.target.value)}
            className="min-h-16"
            maxLength={2000}
          />
        )}
      </Field>
      <Field
        label="Effective from"
        required
        hint="A future date keeps the current published anchor until then."
      >
        {({ id }) => (
          <Input
            id={id}
            type="date"
            value={value.effectiveFrom}
            onChange={(e) => set('effectiveFrom', e.target.value)}
          />
        )}
      </Field>
      <Field label="Effective to (optional)">
        {({ id }) => (
          <Input
            id={id}
            type="date"
            value={value.effectiveTo}
            onChange={(e) => set('effectiveTo', e.target.value)}
          />
        )}
      </Field>
      <Field label="Short description (optional)" className="sm:col-span-2">
        {({ id }) => (
          <Input
            id={id}
            value={value.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={2000}
          />
        )}
      </Field>
      <Field label="Scope details (markdown, optional)" className="sm:col-span-2">
        {({ id }) => (
          <Textarea
            id={id}
            value={value.scopeMarkdown}
            onChange={(e) => set('scopeMarkdown', e.target.value)}
            className="min-h-16"
            maxLength={8000}
          />
        )}
      </Field>
    </div>
  );
}
