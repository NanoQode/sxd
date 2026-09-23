'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  LISTING_PRICE_BASIS_LABELS,
  LISTING_TENURE_LABELS,
  listingPriceBasisSchema,
  listingTenureSchema,
  type ListingDetailDto,
  type ListingKind,
  type ListingLocationPrecision,
  type ListingMediaFileDto,
  type ListingPriceBasis,
  type ListingTenure,
} from '@simplexd/contracts';
import {
  Alert,
  Button,
  Field,
  Input,
  NativeSelect,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

export interface ListableProperty {
  id: string;
  name: string;
  kind: string;
  authority: 'verified' | 'pending' | 'expired' | 'rejected' | 'none';
  hasMarket: boolean;
  hasNeighborhood: boolean;
  hasLocation: boolean;
}

const KINDS: ListingKind[] = ['sale', 'lease', 'short_stay'];
const PRECISIONS: Array<{ value: ListingLocationPrecision; label: string; hint: string }> = [
  { value: 'state', label: 'State only', hint: 'Only the state is shown publicly.' },
  {
    value: 'market',
    label: 'Market (default)',
    hint: 'Market and state are shown; nothing more precise.',
  },
  {
    value: 'neighborhood',
    label: 'Neighbourhood',
    hint: 'Needs a neighbourhood on the property record.',
  },
  {
    value: 'exact',
    label: 'Exact coordinates',
    hint: 'Publishes the property coordinates. Staff must explicitly approve this at publication.',
  },
];

interface FormState {
  propertyId: string;
  kind: ListingKind;
  title: string;
  description: string;
  priceNaira: string;
  priceBasis: ListingPriceBasis | '';
  areaM2: string;
  tenure: ListingTenure | '';
  titleDisclosure: string;
  availabilityMode: 'now' | 'date';
  availableFrom: string;
  precision: ListingLocationPrecision;
  mediaFileIds: string[];
}

function koboToNairaInput(kobo: string | null): string {
  if (!kobo) return '';
  const whole = BigInt(kobo) / 100n;
  const frac = BigInt(kobo) % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0')}`;
}

/** "12,500,000" or "12500000.50" to a kobo string; null when not a valid amount. */
export function nairaInputToKobo(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^₦/, '')
    .replace(/[,\s_]/g, '');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = m[2] ? BigInt(m[2].padEnd(2, '0')) : 0n;
  const kobo = whole * 100n + frac;
  return kobo > 0n ? kobo.toString() : null;
}

function initial(listing: ListingDetailDto | null, propertyId: string | null): FormState {
  const c = listing?.current;
  const availability = c?.availability ?? 'now';
  return {
    propertyId: listing?.propertyId ?? propertyId ?? '',
    kind: listing?.kind ?? 'sale',
    title: c?.title ?? '',
    description: c?.descriptionMarkdown ?? '',
    priceNaira: koboToNairaInput(c?.priceKobo ?? null),
    priceBasis: listingPriceBasisSchema.safeParse(c?.priceBasis).success
      ? (c!.priceBasis as ListingPriceBasis)
      : '',
    areaM2: c?.areaM2 ?? '',
    tenure: listingTenureSchema.safeParse(c?.tenure).success ? (c!.tenure as ListingTenure) : '',
    titleDisclosure: c?.titleDisclosure ?? '',
    availabilityMode: availability === 'now' ? 'now' : 'date',
    availableFrom: availability === 'now' ? '' : availability,
    precision: c?.publicLocationPrecision ?? 'market',
    mediaFileIds: c?.mediaFileIds ?? [],
  };
}

/**
 * Create or revise a listing. Every save creates a new revision; the version
 * the form was opened with travels as expectedVersion so a concurrent edit is
 * refused rather than overwritten. Prices are optional and typed in naira;
 * nothing is estimated when the owner leaves them empty.
 */
export function ListingForm({
  listing,
  properties,
  media,
  defaultPropertyId,
  onDone,
}: {
  listing: ListingDetailDto | null;
  /** Create mode: properties the organisation can list. */
  properties: ListableProperty[];
  /** Clean images of the organisation that can be attached. */
  media: ListingMediaFileDto[];
  defaultPropertyId?: string | null;
  onDone?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() => initial(listing, defaultPropertyId ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const property = properties.find((p) => p.id === form.propertyId) ?? null;

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!listing && !form.propertyId) errors.propertyId = 'Choose the property to list.';
    if (form.title.trim().length < 8)
      errors.title = 'Give the listing a title of at least 8 characters.';
    if (form.priceNaira.trim() && nairaInputToKobo(form.priceNaira) === null)
      errors.priceNaira = 'Enter a whole or two-decimal naira amount, e.g. 12,500,000.';
    if (form.priceNaira.trim() && !form.priceBasis)
      errors.priceBasis = 'State what the price is for (outright, per year, per plot…).';
    if (!form.priceNaira.trim() && form.priceBasis)
      errors.priceNaira = 'Enter the price, or clear the basis to show "price on request".';
    if (form.areaM2.trim() && !/^\d{1,12}(\.\d{1,2})?$/.test(form.areaM2.trim()))
      errors.areaM2 = 'Square metres with at most two decimals.';
    if (form.availabilityMode === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(form.availableFrom))
      errors.availableFrom = 'Choose the date from which the property is available.';
    if (property && form.precision === 'neighborhood' && !property.hasNeighborhood)
      errors.precision = 'The property has no neighbourhood recorded.';
    if (property && form.precision === 'exact' && !property.hasLocation)
      errors.precision = 'The property has no coordinates recorded.';
    return errors;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const content = {
      title: form.title.trim(),
      descriptionMarkdown: form.description.trim() || null,
      priceKobo: form.priceNaira.trim() ? nairaInputToKobo(form.priceNaira) : null,
      priceBasis: form.priceNaira.trim() ? form.priceBasis || null : null,
      areaM2: form.areaM2.trim() || null,
      tenure: form.tenure || null,
      titleDisclosure: form.titleDisclosure.trim() || null,
      availability: form.availabilityMode === 'now' ? 'now' : form.availableFrom,
      mediaFileIds: form.mediaFileIds,
      publicLocationPrecision: form.precision,
    };
    try {
      if (listing) {
        await portalFetch<ListingDetailDto>(`/api/v1/listings/${listing.id}`, {
          method: 'PATCH',
          body: { ...content, expectedVersion: listing.version },
        });
        toast({ title: `Revision ${listing.currentVersion + 1} saved`, tone: 'success' });
        onDone?.();
        router.refresh();
      } else {
        const created = await portalFetch<ListingDetailDto>('/api/v1/listings', {
          body: { ...content, propertyId: form.propertyId, kind: form.kind },
        });
        toast({ title: 'Draft listing created', tone: 'success' });
        router.push(`/portal/listings/${created.id}`);
        router.refresh();
      }
    } catch (err) {
      const e = describeError(err);
      setError({
        message:
          e.code === 'version_conflict'
            ? `${e.message} Reload the page to see the latest revision.`
            : e.message,
        correlationId: e.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  const toggleMedia = (id: string) =>
    set(
      'mediaFileIds',
      form.mediaFileIds.includes(id)
        ? form.mediaFileIds.filter((m) => m !== id)
        : [...form.mediaFileIds, id],
    );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      {error ? (
        <ErrorState
          title="Could not save"
          message={error.message}
          correlationId={error.correlationId}
        />
      ) : null}
      {listing ? (
        <Alert tone="info" title={`Saving creates revision ${listing.currentVersion + 1}`}>
          Earlier revisions are kept.{' '}
          {listing.publishedVersion !== null
            ? 'The public page keeps showing the approved revision until the new one is submitted and approved.'
            : 'Submit the listing for moderation when you are ready.'}
        </Alert>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2">
        {!listing ? (
          <>
            <Field label="Property" htmlFor="lf-property" error={fieldErrors.propertyId} required>
              {({ id, describedBy, invalid }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={form.propertyId}
                  onChange={(e) => set('propertyId', e.target.value)}
                >
                  <option value="">Choose a property</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({humanize(p.kind)}; authority {p.authority})
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Listing type" htmlFor="lf-kind" required>
              {({ id, describedBy }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  value={form.kind}
                  onChange={(e) => set('kind', e.target.value as ListingKind)}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </>
        ) : null}
        {property && property.authority !== 'verified' ? (
          <Alert tone="warning" title="Owner authority not verified" className="sm:col-span-2">
            You can draft the listing now, but submitting it for moderation needs a verified,
            unexpired owner authority for this property (currently: {property.authority}). Submit
            the authority document from the property page.
          </Alert>
        ) : null}
        <Field
          label="Title"
          htmlFor="lf-title"
          error={fieldErrors.title}
          required
          className="sm:col-span-2"
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              maxLength={140}
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Description"
          htmlFor="lf-description"
          hint="Plain text or simple Markdown. Images and scripts are not published; contact details belong in inquiries, not here."
          className="sm:col-span-2"
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              rows={6}
              aria-describedby={describedBy}
              maxLength={8000}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Price (₦, optional)"
          htmlFor="lf-price"
          hint='Leave empty to show "price on request". Nothing is estimated for you.'
          error={fieldErrors.priceNaira}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="decimal"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="e.g. 12,500,000"
              value={form.priceNaira}
              onChange={(e) => set('priceNaira', e.target.value)}
            />
          )}
        </Field>
        <Field label="Price basis" htmlFor="lf-basis" error={fieldErrors.priceBasis}>
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={form.priceBasis}
              onChange={(e) => set('priceBasis', e.target.value as ListingPriceBasis | '')}
            >
              <option value="">Not applicable</option>
              {listingPriceBasisSchema.options.map((b) => (
                <option key={b} value={b}>
                  {LISTING_PRICE_BASIS_LABELS[b]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Area (m², optional)" htmlFor="lf-area" error={fieldErrors.areaM2}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="decimal"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={form.areaM2}
              onChange={(e) => set('areaM2', e.target.value)}
            />
          )}
        </Field>
        <Field label="Tenure" htmlFor="lf-tenure">
          {({ id, describedBy }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              value={form.tenure}
              onChange={(e) => set('tenure', e.target.value as ListingTenure | '')}
            >
              <option value="">Not stated</option>
              {listingTenureSchema.options.map((t) => (
                <option key={t} value={t}>
                  {LISTING_TENURE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Title disclosure"
          htmlFor="lf-disclosure"
          hint="Documents held, encumbrances, pending consents or disputes, in your own words. Shown publicly as stated by you."
          className="sm:col-span-2"
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              rows={3}
              aria-describedby={describedBy}
              maxLength={2000}
              value={form.titleDisclosure}
              onChange={(e) => set('titleDisclosure', e.target.value)}
            />
          )}
        </Field>
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">Availability</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="availability"
              checked={form.availabilityMode === 'now'}
              onChange={() => set('availabilityMode', 'now')}
            />
            Available now
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="availability"
              checked={form.availabilityMode === 'date'}
              onChange={() => set('availabilityMode', 'date')}
            />
            Available from a date
          </label>
          {form.availabilityMode === 'date' ? (
            <Field
              label="Available from"
              htmlFor="lf-available-from"
              error={fieldErrors.availableFrom}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="date"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={form.availableFrom}
                  onChange={(e) => set('availableFrom', e.target.value)}
                />
              )}
            </Field>
          ) : null}
        </fieldset>
        <Field
          label="Public location precision"
          htmlFor="lf-precision"
          hint={PRECISIONS.find((p) => p.value === form.precision)?.hint}
          error={fieldErrors.precision}
          className="sm:col-span-2"
        >
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={form.precision}
              onChange={(e) => set('precision', e.target.value as ListingLocationPrecision)}
            >
              {PRECISIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">Photos</legend>
          <p className="text-sm text-fg-muted">
            Clean image files of your organisation. A photo is shown publicly only after staff
            approve it for public use; until then it is listed as attached but not shown.
          </p>
          {media.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No scanned images yet. Upload photos from the property&apos;s Documents tab; they
              appear here once the malware scan completes.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {media.map((m) => (
                <li
                  key={m.id}
                  className="flex items-start gap-2 rounded-md border border-border p-2 text-sm"
                >
                  <input
                    id={`lf-media-${m.id}`}
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={form.mediaFileIds.includes(m.id)}
                    onChange={() => toggleMedia(m.id)}
                  />
                  <label htmlFor={`lf-media-${m.id}`} className="min-w-0">
                    <span className="block break-all font-medium">{m.originalName}</span>
                    <span className="text-xs text-fg-muted">
                      {m.isPublicApproved
                        ? 'Approved for public use'
                        : 'Not yet approved for public use'}
                      {m.altText ? ` · alt: ${m.altText}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={busy}>
          {listing ? 'Save new revision' : 'Create draft listing'}
        </Button>
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
