'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  Alert,
  Button,
  ErrorSummary,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { GEOGRAPHY_LEVELS, NUMERIC_REPRESENTATIONS, STATISTICS, humanize } from '../../_lib/params';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .or(z.literal(''));

const schema = z
  .object({
    sourceId: z.string().uuid('Choose a source'),
    sourceUrl: z.string(),
    metric: z.string().trim().min(1, 'Enter the metric key').max(80),
    statistic: z.enum(STATISTICS),
    value: z.string(),
    valueLow: z.string(),
    valueHigh: z.string(),
    valueText: z.string().max(500),
    unit: z.string().trim().min(1, 'Enter the unit').max(60),
    currency: z.string(),
    numericRepresentation: z.enum(NUMERIC_REPRESENTATIONS),
    geographyLevel: z.enum(GEOGRAPHY_LEVELS),
    geographyLabel: z.string().trim().min(1, 'Enter the source geography label').max(120),
    stateId: z.string(),
    marketId: z.string(),
    propertyCohort: z.string().trim().min(1, 'Enter the property cohort').max(120),
    observationPeriodStart: date,
    observationPeriodEnd: date,
    periodCompleteAtRetrieval: z.enum(['unknown', 'yes', 'no']),
    sourceUpdatedAt: date,
    retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the retrieval date'),
    sampleSize: z.string(),
    collectionMethod: z.string().max(120),
    licenseNote: z.string().max(500),
    validUntil: date,
    editorialNote: z.string().max(2000),
    slug: z.string(),
  })
  .superRefine((v, ctx) => {
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    if (
      ['median', 'mean', 'min', 'max', 'count', 'quote', 'single_observation'].includes(
        v.statistic,
      ) &&
      num(v.value) === null
    )
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'This statistic needs a numeric value',
      });
    if (v.statistic === 'range' && (num(v.valueLow) === null || num(v.valueHigh) === null))
      ctx.addIssue({
        code: 'custom',
        path: ['valueLow'],
        message: 'A range needs low and high values',
      });
    if (v.statistic === 'categorical' && !v.valueText.trim())
      ctx.addIssue({
        code: 'custom',
        path: ['valueText'],
        message: 'A categorical observation needs a text value',
      });
    if (v.geographyLevel === 'state_or_fct' && !v.stateId)
      ctx.addIssue({ code: 'custom', path: ['stateId'], message: 'Choose the state' });
    if (['city', 'neighborhood', 'site'].includes(v.geographyLevel) && !v.marketId)
      ctx.addIssue({ code: 'custom', path: ['marketId'], message: 'Choose the market' });
    if (v.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug))
      ctx.addIssue({
        code: 'custom',
        path: ['slug'],
        message: 'Lowercase letters, digits and hyphens',
      });
  });
type Values = z.infer<typeof schema>;

export function ObservationForm({
  sources,
  markets,
  states,
  defaultMarketId,
}: {
  sources: Array<{ id: string; title: string; licenseRights: string }>;
  markets: Array<{ id: string; name: string; slug: string }>;
  states: Array<{ id: string; name: string }>;
  defaultMarketId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      sourceId: '',
      sourceUrl: '',
      metric: '',
      statistic: 'median',
      value: '',
      valueLow: '',
      valueHigh: '',
      valueText: '',
      unit: '',
      currency: 'NGN',
      numericRepresentation: 'whole_naira_not_kobo',
      geographyLevel: defaultMarketId ? 'city' : 'state_or_fct',
      geographyLabel: '',
      stateId: '',
      marketId: defaultMarketId,
      propertyCohort: '',
      observationPeriodStart: '',
      observationPeriodEnd: '',
      periodCompleteAtRetrieval: 'unknown',
      sourceUpdatedAt: '',
      retrievedAt: new Date().toISOString().slice(0, 10),
      sampleSize: '',
      collectionMethod: 'published_report_read',
      licenseNote: '',
      validUntil: '',
      editorialNote: '',
      slug: '',
    },
  });
  const { register, handleSubmit, watch, formState } = form;
  const level = watch('geographyLevel');
  const statistic = watch('statistic');
  const sourceId = watch('sourceId');
  const source = sources.find((s) => s.id === sourceId);

  const onSubmit = handleSubmit(async (v) => {
    setServerError(null);
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    const opt = (s: string) => (s.trim() === '' ? null : s.trim());
    try {
      const created = await apiFetch<{ id: string }>('/api/v1/admin/observations', {
        body: {
          sourceId: v.sourceId,
          sourceUrl: opt(v.sourceUrl),
          metric: v.metric,
          statistic: v.statistic,
          value: num(v.value),
          valueLow: num(v.valueLow),
          valueHigh: num(v.valueHigh),
          valueText: opt(v.valueText),
          unit: v.unit,
          currency: opt(v.currency),
          numericRepresentation: v.numericRepresentation,
          geographyLevel: v.geographyLevel,
          geographyLabel: v.geographyLabel,
          stateId: v.geographyLevel === 'state_or_fct' ? v.stateId || null : null,
          marketId: ['city', 'neighborhood', 'site'].includes(v.geographyLevel)
            ? v.marketId || null
            : null,
          propertyCohort: v.propertyCohort,
          observationPeriodStart: opt(v.observationPeriodStart),
          observationPeriodEnd: opt(v.observationPeriodEnd),
          periodCompleteAtRetrieval:
            v.periodCompleteAtRetrieval === 'unknown'
              ? null
              : v.periodCompleteAtRetrieval === 'yes',
          sourceUpdatedAt: opt(v.sourceUpdatedAt),
          retrievedAt: v.retrievedAt,
          sampleSize: num(v.sampleSize),
          collectionMethod: opt(v.collectionMethod),
          licenseNote: opt(v.licenseNote),
          validUntil: opt(v.validUntil),
          editorialNote: opt(v.editorialNote),
          slug: opt(v.slug) ?? undefined,
        },
      });
      toast({ title: 'Observation submitted for review', tone: 'success' });
      router.push(`/admin/market-data/observations/${created.id}`);
      router.refresh();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  const errors = Object.entries(formState.errors).map(([k, e]) => ({
    id: `of-${k}`,
    message: e?.message ?? k,
  }));
  const f = (name: keyof Values) => ({
    htmlFor: `of-${name}`,
    error: formState.errors[name]?.message,
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {serverError ? (
        <Alert tone="danger" title="Could not record the observation">
          {serverError}
        </Alert>
      ) : null}
      <ErrorSummary errors={errors} />
      <fieldset className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4 md:grid-cols-2">
        <legend className="px-1 text-sm font-medium">Source and provenance</legend>
        <Field
          label="Source"
          required
          {...f('sourceId')}
          hint={
            source
              ? `Rights: ${humanize(source.licenseRights)}`
              : 'Register sources first if missing.'
          }
        >
          {({ id, invalid, describedBy }) => (
            <NativeSelect
              id={id}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...register('sourceId')}
            >
              <option value="">Choose a source</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Source URL (specific page)" {...f('sourceUrl')}>
          {({ id }) => <Input id={id} type="url" {...register('sourceUrl')} />}
        </Field>
        <Field
          label="Retrieved on"
          required
          {...f('retrievedAt')}
          hint="When you read it, not when it was measured."
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="date"
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...register('retrievedAt')}
            />
          )}
        </Field>
        <Field label="Source updated on" {...f('sourceUpdatedAt')}>
          {({ id }) => <Input id={id} type="date" {...register('sourceUpdatedAt')} />}
        </Field>
        <Field label="Collection method" {...f('collectionMethod')}>
          {({ id }) => (
            <NativeSelect id={id} {...register('collectionMethod')}>
              {[
                'published_report_read',
                'first_party_survey',
                'supplier_quotation',
                'official_publication',
                'licensed_dataset',
                'field_visit',
                'other',
              ].map((m) => (
                <option key={m} value={m}>
                  {humanize(m)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="License / use note" {...f('licenseNote')}>
          {({ id }) => <Input id={id} {...register('licenseNote')} />}
        </Field>
        <Field
          label="Sample size"
          {...f('sampleSize')}
          hint="Listings or records behind the figure, if stated."
        >
          {({ id }) => <Input id={id} type="number" min={0} {...register('sampleSize')} />}
        </Field>
        <Field
          label="Stable slug (optional)"
          {...f('slug')}
          hint="Lets a CSV re-import skip this row."
        >
          {({ id }) => <Input id={id} {...register('slug')} />}
        </Field>
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4 md:grid-cols-3">
        <legend className="px-1 text-sm font-medium">Measurement</legend>
        <Field
          label="Metric key"
          required
          {...f('metric')}
          hint="e.g. annual_rent_median, sale_price_median, cement_50kg_delivered"
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...register('metric')}
            />
          )}
        </Field>
        <Field label="Statistic" required {...f('statistic')}>
          {({ id }) => (
            <NativeSelect id={id} {...register('statistic')}>
              {STATISTICS.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Property cohort"
          required
          {...f('propertyCohort')}
          hint="e.g. 3-bedroom flat, mixed advertised stock"
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...register('propertyCohort')}
            />
          )}
        </Field>
        {statistic === 'range' ? (
          <>
            <Field label="Low" required {...f('valueLow')}>
              {({ id, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  aria-invalid={invalid}
                  {...register('valueLow')}
                />
              )}
            </Field>
            <Field label="High" required {...f('valueHigh')}>
              {({ id, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  aria-invalid={invalid}
                  {...register('valueHigh')}
                />
              )}
            </Field>
          </>
        ) : statistic === 'categorical' ? (
          <Field label="Categorical value" required {...f('valueText')}>
            {({ id, invalid }) => (
              <Input id={id} aria-invalid={invalid} {...register('valueText')} />
            )}
          </Field>
        ) : (
          <Field label="Value" required {...f('value')}>
            {({ id, invalid }) => (
              <Input
                id={id}
                type="number"
                step="any"
                aria-invalid={invalid}
                {...register('value')}
              />
            )}
          </Field>
        )}
        <Field label="Unit" required {...f('unit')} hint="e.g. NGN/year, NGN/m2, days, bags">
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...register('unit')}
            />
          )}
        </Field>
        <Field
          label="Numeric representation"
          required
          {...f('numericRepresentation')}
          hint="Whole naira is not kobo."
        >
          {({ id }) => (
            <NativeSelect id={id} {...register('numericRepresentation')}>
              {NUMERIC_REPRESENTATIONS.map((n) => (
                <option key={n} value={n}>
                  {humanize(n)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Currency" {...f('currency')}>
          {({ id }) => <Input id={id} maxLength={3} {...register('currency')} />}
        </Field>
        <Field label="Observation period start" {...f('observationPeriodStart')}>
          {({ id }) => <Input id={id} type="date" {...register('observationPeriodStart')} />}
        </Field>
        <Field label="Observation period end" {...f('observationPeriodEnd')}>
          {({ id }) => <Input id={id} type="date" {...register('observationPeriodEnd')} />}
        </Field>
        <Field label="Period complete at retrieval?" {...f('periodCompleteAtRetrieval')}>
          {({ id }) => (
            <NativeSelect id={id} {...register('periodCompleteAtRetrieval')}>
              <option value="unknown">Unknown</option>
              <option value="yes">Yes</option>
              <option value="no">No (period still running)</option>
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Valid until"
          {...f('validUntil')}
          hint="Source-declared validity (e.g. quote expiry)."
        >
          {({ id }) => <Input id={id} type="date" {...register('validUntil')} />}
        </Field>
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4 md:grid-cols-3">
        <legend className="px-1 text-sm font-medium">Geography</legend>
        <Field
          label="Level"
          required
          {...f('geographyLevel')}
          hint="Statewide figures are context; never clone them into a city."
        >
          {({ id }) => (
            <NativeSelect id={id} {...register('geographyLevel')}>
              {GEOGRAPHY_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {humanize(l)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {level === 'state_or_fct' ? (
          <Field label="State / FCT" required {...f('stateId')}>
            {({ id, invalid }) => (
              <NativeSelect id={id} aria-invalid={invalid} {...register('stateId')}>
                <option value="">Choose a state</option>
                {states.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        {['city', 'neighborhood', 'site'].includes(level) ? (
          <Field label="Market" required {...f('marketId')}>
            {({ id, invalid }) => (
              <NativeSelect id={id} aria-invalid={invalid} {...register('marketId')}>
                <option value="">Choose a market</option>
                {markets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        <Field
          label="Source geography label"
          required
          {...f('geographyLabel')}
          hint="As the source names it, e.g. Oyo State, Ibadan."
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              {...register('geographyLabel')}
            />
          )}
        </Field>
      </fieldset>

      <Field
        label="Editorial note (interpretation v1)"
        htmlFor="of-editorialNote"
        hint="Context for reviewers: stock mix, caveats, why it matters."
      >
        {({ id }) => <Textarea id={id} {...register('editorialNote')} />}
      </Field>
      <div className="flex gap-2">
        <Button type="submit" loading={formState.isSubmitting} loadingLabel="Submitting">
          Submit for review
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
