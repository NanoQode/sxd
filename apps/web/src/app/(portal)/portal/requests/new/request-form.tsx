'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  PREFERRED_TIMELINE_LABELS,
  preferredTimelineSchema,
  type BookableServiceDto,
  type ServiceRequestDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  NativeSelect,
  Textarea,
  cn,
  formatNairaString,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

const INTAKE_LABELS: Record<string, { label: string; hint?: string; multiline?: boolean }> = {
  property: {
    label: 'Property or site',
    hint: 'Address or description of the property this request concerns.',
  },
  project_stage: {
    label: 'Project stage',
    hint: 'e.g. land only, foundations, roofing, finishing.',
  },
  drawings_or_boq: {
    label: 'Drawings or bill of quantities',
    hint: 'Describe what you already have. File uploads arrive in Wave 2.',
    multiline: true,
  },
  site_access: { label: 'Site access', hint: 'Who grants access and any constraints.' },
  title_documents: {
    label: 'Title documents held',
    hint: 'e.g. Certificate of Occupancy, deed of assignment, survey plan.',
    multiline: true,
  },
  seller_contact: { label: 'Seller or agent contact', hint: 'Name and how to reach them.' },
  brief: { label: 'Design brief', hint: 'What you want to build and for whom.', multiline: true },
  site_information: {
    label: 'Site information',
    hint: 'Location, size, topography, existing structures.',
    multiline: true,
  },
  budget_range: { label: 'Budget range', hint: 'Whole naira, low to high.' },
  units: { label: 'Units', hint: 'Number and type of units to manage.' },
  existing_leases: {
    label: 'Existing leases',
    hint: 'Current tenants and lease end dates, if any.',
    multiline: true,
  },
  access_contact: { label: 'Access contact', hint: 'Who meets the inspector on site.' },
  checklist_focus: {
    label: 'Inspection focus',
    hint: 'What should the inspector prioritise?',
    multiline: true,
  },
  search_criteria: {
    label: 'Search criteria',
    hint: 'Location, type, size and must-haves.',
    multiline: true,
  },
  budget: { label: 'Budget', hint: 'Whole naira.' },
  fee_basis_agreement: {
    label: 'Fee basis acknowledgement',
    hint: 'Purchase representation is charged on an agreed percentage basis with signed scope. Type "understood" to confirm.',
  },
  requirements: {
    label: 'Requirements',
    hint: 'Describe what you are looking for.',
    multiline: true,
  },
  locations: { label: 'Preferred locations', hint: 'Cities or neighbourhoods.' },
  owner_authority: {
    label: 'Owner authority',
    hint: 'Your relationship to the land and any authority documents.',
  },
  parcel: { label: 'Parcel details', hint: 'Size, survey reference and location.' },
  title_disclosures: {
    label: 'Title disclosures',
    hint: 'Known encumbrances, disputes or pending consents.',
    multiline: true,
  },
};

function labelFor(key: string) {
  return (
    INTAKE_LABELS[key] ?? { label: key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }
  );
}

const schema = z.object({
  serviceSlug: z.string().min(1, 'Choose a service'),
  title: z.string().trim().max(160).optional(),
  description: z
    .string()
    .trim()
    .min(10, 'Tell us a little more (at least 10 characters)')
    .max(8000),
  marketId: z.string().optional(),
  scenarioId: z.string().optional(),
  budgetNaira: z.string().optional(),
  preferredTimeline: preferredTimelineSchema.or(z.literal('')).optional(),
  intake: z.record(z.string(), z.string().max(2000)),
});
type Values = z.infer<typeof schema>;

function priceLabel(p: BookableServiceDto['startingPrice']): string | null {
  if (!p) return null;
  if (p.basis === 'quotation') return 'By quotation';
  if (p.basis === 'percentage' && p.percentageBps !== null)
    return `${(p.percentageBps / 100).toFixed(2)}% of purchase price`;
  if (p.amountKobo) {
    const amount = formatNairaString(p.amountKobo);
    return p.basis === 'per_month'
      ? `${amount} per month`
      : p.basis === 'from'
        ? `from ${amount}`
        : amount;
  }
  return null;
}

export function RequestForm({
  services,
  markets,
  scenarios,
  initialServiceSlug,
  initialScenarioId,
}: {
  services: BookableServiceDto[];
  markets: Array<{ id: string; label: string }>;
  scenarios: Array<{ id: string; name: string }>;
  initialServiceSlug: string | null;
  initialScenarioId: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [interestDone, setInterestDone] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      serviceSlug:
        initialServiceSlug && services.some((s) => s.slug === initialServiceSlug)
          ? initialServiceSlug
          : '',
      title: '',
      description: '',
      marketId: '',
      scenarioId: initialScenarioId ?? '',
      budgetNaira: '',
      preferredTimeline: '',
      intake: {},
    },
  });
  const serviceSlug = form.watch('serviceSlug');
  const service = useMemo(
    () => services.find((s) => s.slug === serviceSlug) ?? null,
    [services, serviceSlug],
  );

  // Typed intake answers are preserved when switching services; the server keeps only
  // the keys the chosen service's workflow template defines.
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    if (!service) return;
    if (!service.bookable) {
      try {
        const res = await apiFetch<{ leadId: string }>('/api/v1/service-requests/interest', {
          method: 'POST',
          body: {
            serviceSlug: service.slug,
            message: values.description,
            marketId: values.marketId || null,
            scenarioId: values.scenarioId || null,
            budgetNaira: values.budgetNaira ? Number(values.budgetNaira) : null,
          },
        });
        setInterestDone(res.leadId);
      } catch (err) {
        setError(errorMessage(err));
      }
      return;
    }
    try {
      const created = await apiFetch<ServiceRequestDto>('/api/v1/service-requests', {
        method: 'POST',
        body: {
          serviceSlug: service.slug,
          title: values.title || undefined,
          description: values.description,
          marketId: values.marketId || null,
          scenarioId: values.scenarioId || null,
          budgetNaira: values.budgetNaira ? Number(values.budgetNaira) : null,
          preferredTimeline: values.preferredTimeline || null,
          intake: values.intake,
        },
      });
      router.push(`/portal/requests/${created.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (interestDone) {
    return (
      <Alert tone="success" title="Interest registered">
        Thank you. {service?.name} is not bookable yet, so we recorded your interest as an inquiry
        and the operations team will contact you at your account email. Reference{' '}
        {interestDone.slice(0, 8)}.{' '}
        <Link href="/portal/requests" className="font-medium text-primary underline">
          Back to requests
        </Link>
      </Alert>
    );
  }

  const errors = form.formState.errors;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-8">
      {error ? (
        <Alert tone="danger" title="Could not submit">
          {error}
        </Alert>
      ) : null}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">1. Choose a service</legend>
        {errors.serviceSlug ? (
          <p role="alert" className="text-sm text-danger">
            {errors.serviceSlug.message}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((s) => {
            const selected = s.slug === serviceSlug;
            const price = priceLabel(s.startingPrice);
            return (
              <label
                key={s.id}
                className={cn(
                  'sx-transition flex cursor-pointer flex-col gap-1 rounded-lg border p-4 focus-within:outline-2 focus-within:outline-focus',
                  selected
                    ? 'border-primary bg-primary-soft/40'
                    : 'border-border bg-bg-elevated hover:border-border-strong',
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-medium">
                    <input
                      type="radio"
                      value={s.slug}
                      className="mr-2 accent-[var(--sx-primary)]"
                      {...form.register('serviceSlug')}
                    />
                    {s.name}
                  </span>
                  {s.bookable ? (
                    <Badge tone="success">Bookable</Badge>
                  ) : (
                    <Badge tone="warning">Register interest</Badge>
                  )}
                </span>
                <span className="text-sm text-fg-muted">{s.shortDescription}</span>
                {price ? (
                  <span className="text-xs text-fg-subtle">
                    Indicative price: {price}. Final price by quotation.
                  </span>
                ) : null}
                {!s.bookable ? (
                  <span className="text-xs text-fg-subtle">
                    Not staffed for booking yet; we record interest as an inquiry and reply
                    personally.
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      {service ? (
        <>
          <fieldset className="space-y-4">
            <legend className="text-base font-semibold">2. About this request</legend>
            <Field
              label="Title"
              hint="Optional; we generate one from the service and market if left blank."
              error={errors.title?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  maxLength={160}
                  {...form.register('title')}
                />
              )}
            </Field>
            <Field
              label="Description"
              required
              error={errors.description?.message}
              hint="What do you need and by when? Anything the team should know before triage."
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  rows={5}
                  {...form.register('description')}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Market"
                hint="Published markets from the explorer. Leave blank if unsure."
              >
                {({ id }) => (
                  <NativeSelect id={id} {...form.register('marketId')}>
                    <option value="">Not specified</option>
                    {markets.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field
                label="Budget (whole naira)"
                hint="Optional. A range is fine in the description."
                error={errors.budgetNaira?.message}
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1000}
                    aria-describedby={describedBy}
                    {...form.register('budgetNaira')}
                  />
                )}
              </Field>
              <Field label="Preferred timeline">
                {({ id }) => (
                  <NativeSelect id={id} {...form.register('preferredTimeline')}>
                    <option value="">Not specified</option>
                    {Object.entries(PREFERRED_TIMELINE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field
                label="Link a saved scenario"
                hint={
                  scenarios.length === 0
                    ? 'You have no unconverted scenarios yet.'
                    : 'Carries your compared markets and assumptions into the request.'
                }
              >
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    disabled={scenarios.length === 0}
                    {...form.register('scenarioId')}
                  >
                    <option value="">None</option>
                    {scenarios.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
          </fieldset>

          {service.bookable && service.intakeKeys.length > 0 ? (
            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">3. Intake for {service.name}</legend>
              <p className="text-sm text-fg-muted">
                These answers come from the {service.name} workflow template. Skip what you do not
                know; triage will ask.
              </p>
              {service.intakeKeys.map((key) => {
                const meta = labelFor(key);
                return (
                  <Field key={key} label={meta.label} hint={meta.hint}>
                    {({ id, describedBy }) =>
                      meta.multiline ? (
                        <Textarea
                          id={id}
                          aria-describedby={describedBy}
                          rows={3}
                          maxLength={2000}
                          {...form.register(`intake.${key}` as const)}
                        />
                      ) : (
                        <Input
                          id={id}
                          aria-describedby={describedBy}
                          maxLength={2000}
                          {...form.register(`intake.${key}` as const)}
                        />
                      )
                    }
                  </Field>
                );
              })}
              <Alert tone="info" title="Attachments">
                Describe what you have here. Once the request is created you can upload drawings,
                title documents and photos securely from its page; every file is scanned before
                anyone can open it.
              </Alert>
            </fieldset>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              loading={form.formState.isSubmitting}
              loadingLabel={service.bookable ? 'Submitting request' : 'Registering interest'}
            >
              {service.bookable ? 'Submit request' : 'Register interest'}
            </Button>
            <Link
              href="/portal/requests"
              className="sx-touch inline-flex items-center text-sm text-fg-muted underline"
            >
              Cancel
            </Link>
            <span className="text-xs text-fg-subtle">
              Started {Math.max(1, Math.round((Date.now() - startedAt) / 60000))} min ago; nothing
              is saved until you submit.
            </span>
          </div>
        </>
      ) : null}
    </form>
  );
}
