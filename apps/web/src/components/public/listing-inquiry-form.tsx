'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert, Button, ErrorSummary, Field, Input, NativeSelect, Textarea } from '@simplexd/ui';

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    correlationId?: string;
    retryAfterSeconds?: number;
    details?: Array<{ path: string; message: string }>;
  };
}

const INTERESTS = [
  { value: 'buy', label: 'Buying' },
  { value: 'lease', label: 'Leasing or renting' },
  { value: 'agent', label: 'Acting for a client' },
  { value: 'other', label: 'Something else' },
] as const;

const IDS = {
  name: 'li-name',
  email: 'li-email',
  phone: 'li-phone',
  interest: 'li-interest',
  message: 'li-message',
  consent: 'li-consent',
} as const;

type FieldKey = 'contactName' | 'email' | 'phoneE164' | 'interest' | 'message';
const FIELD_IDS: Record<FieldKey, string> = {
  contactName: IDS.name,
  email: IDS.email,
  phoneE164: IDS.phone,
  interest: IDS.interest,
  message: IDS.message,
};

/**
 * Public inquiry about one listing. Posts to
 * /api/v1/public/listings/:slug/inquiries; the honeypot and render-to-submit
 * timing travel with the request. Every value stays in the form on failure.
 */
export function ListingInquiryForm({ slug, title }: { slug: string; title: string }) {
  const startedAt = useRef<number | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState({
    contactName: '',
    email: '',
    phoneE164: '',
    interest: 'buy' as (typeof INTERESTS)[number]['value'],
    message: '',
    marketingConsent: false,
    website: '',
  });
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  function validate(): Partial<Record<FieldKey, string>> {
    const next: Partial<Record<FieldKey, string>> = {};
    if (values.contactName.trim().length < 2) next.contactName = 'Enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()))
      next.email = 'Enter a valid email address.';
    if (values.phoneE164.trim() && !/^\+[1-9]\d{6,14}$/.test(values.phoneE164.trim()))
      next.phoneE164 = 'Use the international format, e.g. +2348012345678.';
    if (values.message.trim().length < 10)
      next.message = 'Say what you would like to know (at least 10 characters).';
    return next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) {
      summaryRef.current?.focus();
      return;
    }
    setBusy(true);
    const now = Date.now();
    const payload = {
      contactName: values.contactName.trim(),
      email: values.email.trim(),
      phoneE164: values.phoneE164.trim() || null,
      interest: values.interest,
      message: values.message.trim(),
      marketingConsent: values.marketingConsent,
      website: values.website,
      elapsedMs: now - (startedAt.current ?? now),
    };
    let res: Response;
    try {
      res = await fetch(`/api/v1/public/listings/${encodeURIComponent(slug)}/inquiries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      setBusy(false);
      setServerError('We could not reach the server. Your message is still here; try again.');
      return;
    }
    setBusy(false);
    if (res.status === 201) {
      const data = (await res.json()) as { id: string };
      setDone(data.id);
      return;
    }
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (res.status === 400 && body?.error?.details?.length) {
      const mapped: Partial<Record<FieldKey, string>> = {};
      for (const d of body.error.details) {
        const key = d.path.split('.')[0] as FieldKey;
        if (key in FIELD_IDS) mapped[key] = d.message;
      }
      setErrors(mapped);
      setServerError('Please correct the highlighted fields and send again.');
      summaryRef.current?.focus();
      return;
    }
    if (res.status === 429) {
      const wait = body?.error?.retryAfterSeconds;
      setServerError(
        `Too many inquiries from this connection or email address. Please try again${
          wait
            ? ` in about ${Math.max(1, Math.ceil(wait / 60))} minute${wait > 90 ? 's' : ''}`
            : ' later'
        }.`,
      );
      return;
    }
    if (res.status === 404) {
      setServerError('This listing is no longer open to inquiries.');
      return;
    }
    setServerError(
      `${body?.error?.message ?? 'Something went wrong on our side.'}${
        body?.error?.correlationId ? ` Reference: ${body.error.correlationId}.` : ''
      }`,
    );
  }

  if (done) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-success/40 bg-success-soft p-4"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold">Inquiry received</h3>
            <p className="mt-1 text-sm text-fg-muted">
              Reference <code className="font-mono text-fg">{done}</code>. The SimplexD team
              qualifies inquiries about {title} before introducing anyone to the owner, and replies
              by email.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const summary = (Object.keys(errors) as FieldKey[]).map((k) => ({
    id: FIELD_IDS[k],
    message: errors[k]!,
  }));

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      className="space-y-4"
      aria-describedby="li-intro"
    >
      <p id="li-intro" className="text-sm text-fg-muted">
        Ask about availability, viewings or documents. Fields marked{' '}
        <span aria-hidden="true">*</span>
        <span className="sr-only">asterisk</span> are required. Your details go to SimplexD staff,
        not directly to the owner.
      </p>
      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        {summary.length > 0 ? <ErrorSummary errors={summary} /> : null}
        {serverError ? (
          <Alert tone="danger" title="Not sent yet" className="mt-2">
            {serverError}
          </Alert>
        ) : null}
      </div>
      <Field label="Full name" htmlFor={IDS.name} error={errors.contactName} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            autoComplete="name"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={values.contactName}
            onChange={(e) => set('contactName', e.target.value)}
          />
        )}
      </Field>
      <Field label="Email" htmlFor={IDS.email} error={errors.email} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="email"
            inputMode="email"
            autoComplete="email"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Phone (optional)"
        htmlFor={IDS.phone}
        hint="International format with country code."
        error={errors.phoneE164}
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
            value={values.phoneE164}
            onChange={(e) => set('phoneE164', e.target.value)}
          />
        )}
      </Field>
      <Field label="I am interested in" htmlFor={IDS.interest} required>
        {({ id, describedBy }) => (
          <NativeSelect
            id={id}
            aria-describedby={describedBy}
            value={values.interest}
            onChange={(e) => set('interest', e.target.value as (typeof INTERESTS)[number]['value'])}
          >
            {INTERESTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Your question" htmlFor={IDS.message} error={errors.message} required>
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            rows={4}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={values.message}
            onChange={(e) => set('message', e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-start gap-2">
        <input
          id={IDS.consent}
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={values.marketingConsent}
          onChange={(e) => set('marketingConsent', e.target.checked)}
        />
        <label htmlFor={IDS.consent} className="text-sm text-fg-muted">
          Email me about similar listings and market updates (optional; withdraw any time).
        </label>
      </div>
      {/* Honeypot: hidden from people, filled by bots. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="li-website">Website</label>
        <input
          id="li-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(e) => set('website', e.target.value)}
        />
      </div>
      <Button type="submit" loading={busy} disabled={busy} className="w-full">
        Send inquiry
      </Button>
    </form>
  );
}
