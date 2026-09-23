'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, ErrorSummary, Field, Input, NativeSelect, Textarea, useToast } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { AVAILABILITY, ZONES, humanize } from '../../_lib/params';
import { NigeriaPointPicker, insideNigeria } from './point-picker';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter the market name').max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and hyphens'),
  aliases: z.string().max(500),
  stateId: z.string().uuid('Choose a state'),
  geopoliticalZone: z.enum(ZONES),
  displayOrder: z.coerce.number().int().min(0),
  selectionBasis: z.string().max(500),
  lon: z.coerce.number({ message: 'Longitude must be a number' }),
  lat: z.coerce.number({ message: 'Latitude must be a number' }),
  coordinateSourceId: z.string(),
  coordinateAccuracy: z.string().max(200),
  parentMarketId: z.string(),
  overlapNote: z.string().max(500),
  serviceAvailability: z.enum(AVAILABILITY),
  profileMarkdown: z.string().max(20_000),
  supplyMappingMethod: z.string().max(500),
  changeReason: z.string().max(500),
}).superRefine((v, ctx) => {
  if (!insideNigeria(v.lon, v.lat)) {
    ctx.addIssue({ code: 'custom', path: ['lon'], message: 'Coordinates must fall inside Nigeria (lon 2.5–15, lat 4–14; longitude first)' });
  }
});
type Values = z.infer<typeof schema>;

export interface MarketFormInitial {
  id?: string;
  version?: number;
  name: string;
  slug: string;
  aliases: string[];
  stateId: string;
  geopoliticalZone: (typeof ZONES)[number];
  displayOrder: number;
  selectionBasis: string | null;
  location: { lon: number; lat: number };
  coordinateSourceId: string | null;
  coordinateAccuracy: string | null;
  parentMarketId: string | null;
  overlapNote: string | null;
  serviceAvailability: (typeof AVAILABILITY)[number];
  profileMarkdown: string | null;
  supplyMappingMethod: string | null;
  publicationState?: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function MarketForm({
  initial,
  states,
  sources,
  markets,
}: {
  initial: MarketFormInitial | null;
  states: Array<{ id: string; name: string; geopoliticalZone: string }>;
  sources: Array<{ id: string; title: string }>;
  markets: Array<{ id: string; name: string; slug: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const editing = Boolean(initial?.id);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? '',
      slug: initial?.slug ?? '',
      aliases: initial?.aliases.join(', ') ?? '',
      stateId: initial?.stateId ?? '',
      geopoliticalZone: initial?.geopoliticalZone ?? 'SW',
      displayOrder: initial?.displayOrder ?? 0,
      selectionBasis: initial?.selectionBasis ?? '',
      lon: initial?.location.lon ?? 7.5,
      lat: initial?.location.lat ?? 9,
      coordinateSourceId: initial?.coordinateSourceId ?? '',
      coordinateAccuracy: initial?.coordinateAccuracy ?? '',
      parentMarketId: initial?.parentMarketId ?? '',
      overlapNote: initial?.overlapNote ?? '',
      serviceAvailability: initial?.serviceAvailability ?? 'pending_operations_confirmation',
      profileMarkdown: initial?.profileMarkdown ?? '',
      supplyMappingMethod: initial?.supplyMappingMethod ?? '',
      changeReason: '',
    },
  });
  const { register, handleSubmit, watch, setValue, formState } = form;
  const lon = watch('lon');
  const lat = watch('lat');

  const onSubmit = handleSubmit(async (v) => {
    setServerError(null);
    if (editing && v.changeReason.trim().length < 3) {
      form.setError('changeReason', { message: 'Describe the change (at least 3 characters)' });
      return;
    }
    const payload = {
      name: v.name,
      slug: v.slug,
      aliases: v.aliases.split(',').map((a) => a.trim()).filter(Boolean),
      stateId: v.stateId,
      geopoliticalZone: v.geopoliticalZone,
      displayOrder: v.displayOrder,
      selectionBasis: v.selectionBasis || null,
      location: { lon: Number(v.lon), lat: Number(v.lat) },
      coordinateSourceId: v.coordinateSourceId || null,
      coordinateAccuracy: v.coordinateAccuracy || null,
      parentMarketId: v.parentMarketId || null,
      overlapNote: v.overlapNote || null,
      serviceAvailability: v.serviceAvailability,
      profileMarkdown: v.profileMarkdown || null,
      supplyMappingMethod: v.supplyMappingMethod || null,
    };
    try {
      if (editing && initial?.id) {
        await apiFetch(`/api/v1/admin/markets/${initial.id}`, {
          method: 'PATCH',
          body: { ...payload, expectedVersion: initial.version, changeReason: v.changeReason.trim() },
        });
        toast({ title: 'Market updated', tone: 'success' });
        router.push(`/admin/market-data/markets/${initial.id}`);
      } else {
        const created = await apiFetch<{ id: string }>('/api/v1/admin/markets', {
          body: { ...payload, changeReason: v.changeReason.trim() || undefined },
        });
        toast({ title: 'Market created as draft', tone: 'success' });
        router.push(`/admin/market-data/markets/${created.id}`);
      }
      router.refresh();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });

  const errors = Object.entries(formState.errors).map(([k, e]) => ({ id: `mf-${k}`, message: e?.message ?? k }));

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {serverError ? (
        <Alert tone="danger" title={editing ? 'Could not save the market' : 'Could not create the market'}>
          {serverError}
        </Alert>
      ) : null}
      <ErrorSummary errors={errors} />
      {initial?.publicationState === 'published' ? (
        <Alert tone="info" title="This market is published">
          Saving changes updates public data immediately and requires the publish permission.
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="mf-name" required error={formState.errors.name?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...register('name', {
                onChange: (e) => {
                  if (!editing && !formState.dirtyFields.slug) setValue('slug', slugify(`ng-${e.target.value}`));
                },
              })}
            />
          )}
        </Field>
        <Field label="Slug (stable id)" htmlFor="mf-slug" required error={formState.errors.slug?.message} hint="Used in URLs and imports; keep it stable.">
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...register('slug')} />}
        </Field>
        <Field label="Aliases" htmlFor="mf-aliases" hint="Comma separated alternative spellings, e.g. Shagamu.">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} {...register('aliases')} />}
        </Field>
        <Field label="State / FCT" htmlFor="mf-stateId" required error={formState.errors.stateId?.message}>
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...register('stateId', {
                onChange: (e) => {
                  const s = states.find((x) => x.id === e.target.value);
                  if (s) setValue('geopoliticalZone', s.geopoliticalZone as Values['geopoliticalZone']);
                },
              })}
            >
              <option value="">Choose a state</option>
              {states.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Geopolitical zone" htmlFor="mf-geopoliticalZone" required>
          {({ id }) => (
            <NativeSelect id={id} {...register('geopoliticalZone')}>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Display order" htmlFor="mf-displayOrder" error={formState.errors.displayOrder?.message}>
          {({ id, invalid }) => <Input id={id} type="number" min={0} aria-invalid={invalid} {...register('displayOrder')} />}
        </Field>
        <Field label="Service availability" htmlFor="mf-serviceAvailability" hint="Operations decides this separately from map publication.">
          {({ id, describedBy }) => (
            <NativeSelect id={id} aria-describedby={describedBy} {...register('serviceAvailability')}>
              {AVAILABILITY.map((a) => (
                <option key={a} value={a}>
                  {humanize(a)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Parent market" htmlFor="mf-parentMarketId" hint="For overlapping metropolitan geographies (e.g. Ikeja within Lagos).">
          {({ id, describedBy }) => (
            <NativeSelect id={id} aria-describedby={describedBy} {...register('parentMarketId')}>
              <option value="">None</option>
              {markets
                .filter((m) => m.id !== initial?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.slug})
                  </option>
                ))}
            </NativeSelect>
          )}
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">Reference point</legend>
        <p className="text-sm text-fg-muted">
          WGS84 coordinates in GeoJSON order (longitude, latitude). A reference coordinate is not a
          surveyed location. Click the outline to move the point.
        </p>
        <NigeriaPointPicker
          lon={Number(lon)}
          lat={Number(lat)}
          onChange={(p) => {
            setValue('lon', Number(p.lon.toFixed(4)), { shouldDirty: true, shouldValidate: true });
            setValue('lat', Number(p.lat.toFixed(4)), { shouldDirty: true, shouldValidate: true });
          }}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Longitude" htmlFor="mf-lon" required error={formState.errors.lon?.message}>
            {({ id, invalid, describedBy }) => <Input id={id} type="number" step="0.0001" aria-invalid={invalid} aria-describedby={describedBy} {...register('lon')} />}
          </Field>
          <Field label="Latitude" htmlFor="mf-lat" required error={formState.errors.lat?.message}>
            {({ id, invalid, describedBy }) => <Input id={id} type="number" step="0.0001" aria-invalid={invalid} aria-describedby={describedBy} {...register('lat')} />}
          </Field>
          <Field label="Coordinate source" htmlFor="mf-coordinateSourceId">
            {({ id }) => (
              <NativeSelect id={id} {...register('coordinateSourceId')}>
                <option value="">Unspecified</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Coordinate accuracy" htmlFor="mf-coordinateAccuracy" hint="e.g. city centroid; not cadastral">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} {...register('coordinateAccuracy')} />}
          </Field>
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Selection basis" htmlFor="mf-selectionBasis">
          {({ id }) => <Textarea id={id} className="min-h-20" {...register('selectionBasis')} />}
        </Field>
        <Field label="Overlap note" htmlFor="mf-overlapNote">
          {({ id }) => <Textarea id={id} className="min-h-20" {...register('overlapNote')} />}
        </Field>
        <Field label="Supply mapping method" htmlFor="mf-supplyMappingMethod">
          {({ id }) => <Textarea id={id} className="min-h-20" {...register('supplyMappingMethod')} />}
        </Field>
        <Field label="Profile (Markdown)" htmlFor="mf-profileMarkdown" className="md:col-span-2">
          {({ id }) => <Textarea id={id} className="min-h-40" {...register('profileMarkdown')} />}
        </Field>
        {editing ? (
          <Field label="Change reason" htmlFor="mf-changeReason" required error={formState.errors.changeReason?.message} hint="Recorded with the revision and audit entry." className="md:col-span-2">
            {({ id, invalid, describedBy }) => <Input id={id} aria-invalid={invalid} aria-describedby={describedBy} {...register('changeReason')} />}
          </Field>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={formState.isSubmitting} loadingLabel="Saving">
          {editing ? 'Save changes' : 'Create draft market'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
