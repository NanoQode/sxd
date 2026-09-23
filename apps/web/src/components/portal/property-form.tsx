'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PropertyDto, PropertyKind, TitleStatus } from '@simplexd/contracts';
import { Button, Field, Input, NativeSelect, Textarea, humanize, useToast } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

const KINDS: PropertyKind[] = [
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
];
const TITLE_STATUSES: TitleStatus[] = [
  'unknown',
  'documents_received',
  'verification_in_progress',
  'verified',
  'issues_found',
  'disputed',
];
const AREA_UNITS = ['m2', 'sqft', 'ha', 'acre', 'plot'] as const;

interface FormState {
  name: string;
  kind: PropertyKind;
  line1: string;
  line2: string;
  city: string;
  state: string;
  landAreaValue: string;
  landAreaUnit: (typeof AREA_UNITS)[number];
  floorAreaM2: string;
  titleType: string;
  titleStatus: TitleStatus;
  titleNote: string;
}

function fromProperty(p: PropertyDto | null): FormState {
  return {
    name: p?.name ?? '',
    kind: p?.kind ?? 'residential',
    line1: p?.address?.line1 ?? '',
    line2: p?.address?.line2 ?? '',
    city: p?.address?.city ?? '',
    state: p?.address?.state ?? '',
    landAreaValue: p?.landArea?.declaredValue ?? '',
    landAreaUnit: (p?.landArea?.declaredUnit as FormState['landAreaUnit']) ?? 'm2',
    floorAreaM2: p?.floorAreaM2 ?? '',
    titleType: p?.titleType ?? '',
    titleStatus: p?.titleStatus ?? 'unknown',
    titleNote: p?.titleNote ?? '',
  };
}

/**
 * Create or edit a property. Declared areas are sent exactly as typed with
 * the unit; the server derives m² and never converts plots. Title status is
 * what the customer knows, and defaults to "unknown" rather than a guess.
 */
export function PropertyForm({
  property,
  onDone,
}: {
  property: PropertyDto | null;
  onDone?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() => fromProperty(property));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function submit() {
    setBusy(true);
    setError(null);
    const address =
      form.line1 || form.line2 || form.city || form.state
        ? {
            ...(form.line1 ? { line1: form.line1 } : {}),
            ...(form.line2 ? { line2: form.line2 } : {}),
            ...(form.city ? { city: form.city } : {}),
            ...(form.state ? { state: form.state } : {}),
            country: 'NG',
          }
        : null;
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      address,
      landArea: form.landAreaValue.trim()
        ? { value: form.landAreaValue.trim(), unit: form.landAreaUnit }
        : null,
      floorAreaM2: form.floorAreaM2.trim() || null,
      titleType: form.titleType.trim() || null,
      titleStatus: form.titleStatus,
      titleNote: form.titleNote.trim() || null,
    };
    try {
      if (property) {
        await portalFetch<PropertyDto>(`/api/v1/properties/${property.id}`, {
          method: 'PATCH',
          body: { ...body, expectedVersion: property.version },
        });
        toast({ title: 'Property updated', tone: 'success' });
        onDone?.();
        router.refresh();
      } else {
        const created = await portalFetch<PropertyDto>('/api/v1/properties', { body });
        toast({ title: 'Property created', tone: 'success' });
        router.push(`/portal/properties/${created.id}`);
        router.refresh();
      }
    } catch (err) {
      const e = describeError(err);
      setError({
        message:
          e.code === 'version_conflict'
            ? `${e.message} Reload the page to see the latest version.`
            : e.message,
        correlationId: e.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-4"
    >
      {error ? (
        <ErrorState
          title={property ? 'Could not update' : 'Could not create'}
          message={error.message}
          correlationId={error.correlationId}
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">
          {({ id }) => (
            <Input
              id={id}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              minLength={2}
              maxLength={160}
              required
            />
          )}
        </Field>
        <Field label="Type" required>
          {({ id }) => (
            <NativeSelect
              id={id}
              value={form.kind}
              onChange={(e) => set('kind', e.target.value as PropertyKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Title status"
          hint="What you know today; the team updates it after verification."
        >
          {({ id, describedBy }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              value={form.titleStatus}
              onChange={(e) => set('titleStatus', e.target.value as TitleStatus)}
            >
              {TITLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Address line 1">
          {({ id }) => (
            <Input
              id={id}
              value={form.line1}
              onChange={(e) => set('line1', e.target.value)}
              maxLength={200}
            />
          )}
        </Field>
        <Field label="Address line 2">
          {({ id }) => (
            <Input
              id={id}
              value={form.line2}
              onChange={(e) => set('line2', e.target.value)}
              maxLength={200}
            />
          )}
        </Field>
        <Field label="City">
          {({ id }) => (
            <Input
              id={id}
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
              maxLength={120}
            />
          )}
        </Field>
        <Field label="State">
          {({ id }) => (
            <Input
              id={id}
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
              maxLength={120}
            />
          )}
        </Field>
        <Field
          label="Land area (as declared)"
          hint="Plots are kept as plots; nothing is converted silently."
        >
          {({ id, describedBy }) => (
            <div className="flex gap-2">
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={form.landAreaValue}
                onChange={(e) => set('landAreaValue', e.target.value)}
                placeholder="e.g. 648"
              />
              <NativeSelect
                aria-label="Land area unit"
                className="w-28"
                value={form.landAreaUnit}
                onChange={(e) => set('landAreaUnit', e.target.value as FormState['landAreaUnit'])}
              >
                {AREA_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u === 'm2' ? 'm²' : u}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </Field>
        <Field label="Floor area (m²)">
          {({ id }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={form.floorAreaM2}
              onChange={(e) => set('floorAreaM2', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Title type"
          hint="e.g. Certificate of Occupancy, Deed of Assignment, Governor's Consent."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={form.titleType}
              onChange={(e) => set('titleType', e.target.value)}
              maxLength={120}
            />
          )}
        </Field>
        <Field label="Title note" className="sm:col-span-2">
          {({ id }) => (
            <Textarea
              id={id}
              rows={3}
              maxLength={4000}
              value={form.titleNote}
              onChange={(e) => set('titleNote', e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          {property ? 'Save changes' : 'Create property'}
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
