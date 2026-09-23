'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { CheckCircle2 } from 'lucide-react';
import {
  Alert,
  Button,
  buttonVariants,
  cn,
  ErrorSummary,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from '@simplexd/ui';
import { trackEvent } from './analytics';
import {
  buildConsultationPayload,
  consultationFormSchema,
  fieldForApiPath,
  GOAL_VALUES,
  type ConsultationFormValues,
  type ConsultationPrefill,
} from './consultation-schema';
import { COUNTRY_OPTIONS } from './countries';
import { GOAL_LABELS } from './defaults';

export interface ConsultationServiceOption {
  slug: string;
  name: string;
  category: 'core' | 'expansion';
}

export interface ConsultationFormProps {
  services: ConsultationServiceOption[];
  prefill: ConsultationPrefill;
  /** Book page collects preferred days/times; the homepage form keeps it optional. */
  variant?: 'homepage' | 'book' | 'contact';
  /** Market names for the ids carried from the explorer, when known. */
  marketNames?: string[];
}

const IDS = {
  name: 'cf-name',
  email: 'cf-email',
  phone: 'cf-phone',
  country: 'cf-country',
  timeZone: 'cf-timezone',
  goal: 'cf-goal',
  service: 'cf-service',
  times: 'cf-times',
  message: 'cf-message',
  consent: 'cf-consent',
} as const;

const FIELD_ORDER: Array<[keyof ConsultationFormValues, string]> = [
  ['contactName', IDS.name],
  ['email', IDS.email],
  ['phone', IDS.phone],
  ['countryOfResidence', IDS.country],
  ['timeZone', IDS.timeZone],
  ['goal', IDS.goal],
  ['serviceSlug', IDS.service],
  ['preferredTimes', IDS.times],
  ['message', IDS.message],
  ['marketingConsent', IDS.consent],
];

function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lagos';
  } catch {
    return 'Africa/Lagos';
  }
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    correlationId?: string;
    retryAfterSeconds?: number;
    details?: Array<{ path: string; message: string }>;
  };
}

/**
 * Progressive consultation request form. Carries scenario, markets and budget
 * from the URL, auto-detects the time zone, posts to /api/v1/leads/consultation,
 * shows a validation summary and keeps every value on failure.
 */
export function ConsultationForm({
  services,
  prefill,
  variant = 'homepage',
  marketNames = [],
}: ConsultationFormProps) {
  // Set when the form mounts; used for the too-fast submission heuristic.
  const startedAt = useRef<number | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ id: string } | null>(null);
  const [attempted, setAttempted] = useState(false);

  const form = useForm<ConsultationFormValues>({
    resolver: zodResolver(consultationFormSchema),
    defaultValues: {
      contactName: '',
      email: '',
      phone: '',
      countryOfResidence: '',
      timeZone: 'Africa/Lagos',
      goal: prefill.goal ?? (variant === 'contact' ? 'other' : 'buy_safely'),
      serviceSlug: prefill.serviceSlug ?? '',
      preferredTimes: '',
      message: '',
      marketingConsent: false,
      website: '',
    },
  });

  useEffect(() => {
    startedAt.current = Date.now();
    form.setValue('timeZone', detectTimeZone());
  }, [form]);

  const errors = form.formState.errors;
  const summary = useMemo(
    () =>
      FIELD_ORDER.flatMap(([key, id]) => {
        const message = errors[key]?.message;
        return message ? [{ id, message: String(message) }] : [];
      }),
    [errors],
  );

  useEffect(() => {
    if (attempted && summary.length > 0) summaryRef.current?.focus();
  }, [attempted, summary.length]);

  const submitValues = async (values: ConsultationFormValues) => {
    setServerError(null);
    const now = Date.now();
    const payload = buildConsultationPayload(values, {
      prefill,
      elapsedMs: now - (startedAt.current ?? now),
      source: variant === 'book' ? 'consultation_booking' : 'website_form',
    });
    let res: Response;
    try {
      res = await fetch('/api/v1/leads/consultation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      setServerError(
        'We could not reach the server. Your details are still in the form; check your connection and try again.',
      );
      return;
    }
    if (res.status === 201 || res.status === 200) {
      const data = (await res.json()) as { id: string };
      setSubmitted({ id: data.id });
      trackEvent('consultation_submitted', {
        goal: values.goal,
        service: values.serviceSlug || 'none',
        variant,
      });
      return;
    }
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (res.status === 400 && body?.error?.details?.length) {
      let mapped = 0;
      for (const d of body.error.details) {
        const field = fieldForApiPath(d.path);
        if (field) {
          form.setError(field, { type: 'server', message: d.message });
          mapped += 1;
        }
      }
      setAttempted(true);
      setServerError(
        mapped > 0
          ? 'Please correct the highlighted fields and send again.'
          : (body.error.message ?? 'The request could not be validated.'),
      );
      return;
    }
    if (res.status === 429) {
      const wait = body?.error?.retryAfterSeconds;
      setServerError(
        `Too many requests from this connection or email address. Please try again${wait ? ` in about ${Math.ceil(wait / 60)} minute${wait > 90 ? 's' : ''}` : ' shortly'}. Your details are kept in the form.`,
      );
      return;
    }
    setServerError(
      `${body?.error?.message ?? 'Something went wrong on our side.'} Your details are kept in the form.${body?.error?.correlationId ? ` Reference: ${body.error.correlationId}.` : ''}`,
    );
  };
  const onInvalid = () => setAttempted(true);

  if (submitted) {
    return (
      <div
        role="status"
        className="rounded-lg border border-success/40 bg-success-soft p-5"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">Request received</h3>
            <p className="mt-1 text-sm text-fg-muted">
              Reference <code className="font-mono text-fg">{submitted.id}</code>. A member of the
              team replies by email to confirm scope and a time. Calendar invitations with Google
              Meet links are sent once the calendar integration is configured.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href="/explore"
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                Explore locations
              </Link>
              <Link
                href="/how-it-works"
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                What happens next
              </Link>
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  setSubmitted(null);
                  setAttempted(false);
                  form.reset({ ...form.getValues(), message: '', preferredTimes: '' });
                  startedAt.current = Date.now();
                }}
              >
                Send another request
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const context: string[] = [];
  if (prefill.scenarioId) context.push('your saved scenario');
  if (prefill.marketIds.length > 0)
    context.push(
      marketNames.length > 0
        ? `locations: ${marketNames.join(', ')}`
        : `${prefill.marketIds.length} selected location${prefill.marketIds.length > 1 ? 's' : ''}`,
    );
  if (prefill.marketSlug && prefill.marketIds.length === 0)
    context.push(`location: ${prefill.marketSlug}`);
  if (prefill.budgetNaira)
    context.push(
      `budget ₦${prefill.budgetNaira.toLocaleString('en-NG', { maximumFractionDigits: 0 })}`,
    );

  const coreServices = services.filter((s) => s.category === 'core');
  const plannedServices = services.filter((s) => s.category === 'expansion');

  return (
    <form
      onSubmit={(event) => void form.handleSubmit(submitValues, onInvalid)(event)}
      noValidate
      className="space-y-5"
      aria-describedby="cf-intro"
    >
      <p id="cf-intro" className="text-sm text-fg-muted">
        Fields marked <span aria-hidden="true">*</span>
        <span className="sr-only">asterisk</span> are required. We reply by email; your phone number
        is optional.
      </p>
      {context.length > 0 ? (
        <Alert tone="info" title="Carried from your exploration">
          This request includes {context.join(', ')}. You will not need to repeat them.
        </Alert>
      ) : null}
      {prefill.interest ? (
        <Alert tone="info" title="Interest registration">
          This service is planned and not yet bookable. Registering interest tells the team who to
          contact when it opens; it does not start an engagement.
        </Alert>
      ) : null}
      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        {attempted && summary.length > 0 ? <ErrorSummary errors={summary} /> : null}
        {serverError ? (
          <Alert tone="danger" title="Not sent yet" className="mt-2">
            {serverError}
          </Alert>
        ) : null}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Full name" htmlFor={IDS.name} error={errors.contactName?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              autoComplete="name"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('contactName')}
            />
          )}
        </Field>
        <Field label="Email" htmlFor={IDS.email} error={errors.email?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="email"
              inputMode="email"
              autoComplete="email"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('email')}
            />
          )}
        </Field>
        <Field
          label="Phone (optional)"
          htmlFor={IDS.phone}
          hint="International format with country code, e.g. +2348012345678 or +447700900123."
          error={errors.phone?.message}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+234…"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('phone')}
            />
          )}
        </Field>
        <Field
          label="Country of residence"
          htmlFor={IDS.country}
          error={errors.countryOfResidence?.message}
        >
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              autoComplete="country"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('countryOfResidence')}
            >
              <option value="">Select a country</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Your time zone"
          htmlFor={IDS.timeZone}
          hint="Detected from your browser; edit it if you are travelling. Appointments are shown in this zone and in Africa/Lagos."
          error={errors.timeZone?.message}
          required
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              {...form.register('timeZone')}
            />
          )}
        </Field>
        <Field
          label="What do you want to achieve?"
          htmlFor={IDS.goal}
          error={errors.goal?.message}
          required
        >
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('goal')}
            >
              {GOAL_VALUES.map((g) => (
                <option key={g} value={g}>
                  {GOAL_LABELS[g]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Service"
          htmlFor={IDS.service}
          hint="Leave blank if you are not sure; triage will suggest one."
          error={errors.serviceSlug?.message}
          className="sm:col-span-2"
        >
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('serviceSlug')}
            >
              <option value="">Not sure yet</option>
              {coreServices.length > 0 ? (
                <optgroup label="Core services">
                  {coreServices.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {plannedServices.length > 0 ? (
                <optgroup label="Planned services (interest only)">
                  {plannedServices.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </NativeSelect>
          )}
        </Field>
        {variant !== 'contact' ? (
          <Field
            label={
              variant === 'book'
                ? 'Preferred days and times'
                : 'Preferred days and times (optional)'
            }
            htmlFor={IDS.times}
            hint="For example: weekday evenings after 18:00, or Saturday mornings. Given in your time zone above."
            error={errors.preferredTimes?.message}
            className="sm:col-span-2"
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('preferredTimes')}
              />
            )}
          </Field>
        ) : null}
        <Field
          label="Message"
          htmlFor={IDS.message}
          hint="The property or land, its location, what stage you are at and any deadline."
          error={errors.message?.message}
          className="sm:col-span-2"
        >
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              rows={5}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('message')}
            />
          )}
        </Field>
      </div>

      {/* Honeypot: visually hidden and excluded from the tab order. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="cf-website">Website</label>
        <input
          id="cf-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          {...form.register('website')}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={IDS.consent} className="flex items-start gap-2 text-sm">
          <input
            id={IDS.consent}
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[var(--sx-primary)]"
            {...form.register('marketingConsent')}
          />
          <span>
            Email me occasional updates about SimplexD services and location evidence. Optional; you
            can withdraw at any time. Replies to this request are sent regardless.
          </span>
        </label>
      </div>

      <p className="text-xs text-fg-muted">
        By sending this request you agree to the{' '}
        <Link href="/policies/privacy" className="text-primary underline">
          privacy notice
        </Link>
        . Your IP address is stored only as a hash for abuse control.
      </p>

      <Button
        type="submit"
        size="lg"
        className={cn('w-full sm:w-auto')}
        loading={form.formState.isSubmitting}
        loadingLabel="Sending request"
      >
        {prefill.interest ? 'Register interest' : 'Send consultation request'}
      </Button>
    </form>
  );
}
