'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SavedSearchDto, SavedSearchMatchesDto } from '@simplexd/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Switch,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { koboToNaira } from '@/lib/portal/format';
import { ErrorState } from './error-state';

/**
 * Saved searches with alerts: criteria (listing kind, price and area range,
 * markets or states, tenure and title disclosure, verification checks),
 * a preview of today's matches, alerts on/off and deletion. Alerts announce
 * a listing at most once per search (in-app and email).
 */

const KINDS = ['sale', 'lease', 'short_stay'] as const;
const PROPERTY_KINDS = [
  'land',
  'residential',
  'commercial',
  'industrial',
  'mixed_use',
  'student_housing',
  'short_stay',
] as const;
const CHECKS = [
  { value: 'owner_authority', label: 'Owner authority reviewed' },
  { value: 'title_document_sighted', label: 'Title document sighted' },
  { value: 'registry_search', label: 'Land registry search' },
  { value: 'survey_plan_sighted', label: 'Survey plan sighted' },
  { value: 'site_visit', label: 'Site visit' },
];

type Err = { message: string; correlationId: string | null } | null;

function nairaToKobo(input: string): string | null {
  const cleaned = input.replace(/[,\s₦]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) return 'invalid';
  return `${cleaned}00`;
}

export function SavedSearchesManager({
  searches,
  markets,
  states,
  zone,
  canManage,
  cannotManageReason,
}: {
  searches: SavedSearchDto[];
  markets: Array<{ id: string; name: string }>;
  states: Array<{ id: string; name: string }>;
  zone: string;
  canManage: boolean;
  cannotManageReason: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const [name, setName] = useState('');
  const [kinds, setKinds] = useState<string[]>(['sale']);
  const [propertyKinds, setPropertyKinds] = useState<string[]>([]);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minArea, setMinArea] = useState('');
  const [maxArea, setMaxArea] = useState('');
  const [marketIds, setMarketIds] = useState<string[]>([]);
  const [stateIds, setStateIds] = useState<string[]>([]);
  const [tenure, setTenure] = useState(false);
  const [title, setTitle] = useState(false);
  const [checks, setChecks] = useState<string[]>([]);
  const [keywords, setKeywords] = useState('');
  const [alerts, setAlerts] = useState(true);
  const [matches, setMatches] = useState<
    Record<string, SavedSearchMatchesDto | 'loading' | undefined>
  >({});

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  async function create() {
    const min = nairaToKobo(minPrice);
    const max = nairaToKobo(maxPrice);
    if (min === 'invalid' || max === 'invalid') {
      setError({ message: 'Prices are whole naira amounts.', correlationId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch('/api/v1/saved-searches', {
        body: {
          name: name.trim(),
          alertsEnabled: alerts,
          criteria: {
            listingKinds: kinds,
            propertyKinds,
            minPriceKobo: min,
            maxPriceKobo: max,
            minAreaM2: minArea ? Number(minArea) : null,
            maxAreaM2: maxArea ? Number(maxArea) : null,
            marketIds,
            stateIds,
            requireTenureDisclosed: tenure,
            requireTitleDisclosure: title,
            requiredVerificationChecks: checks,
            keywords: keywords.trim() || null,
          },
        },
      });
      toast({ title: 'Search saved', tone: 'success' });
      setOpen(false);
      setName('');
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  async function patch(s: SavedSearchDto, body: Record<string, unknown>, success: string) {
    try {
      await portalFetch(`/api/v1/saved-searches/${s.id}`, {
        method: 'PATCH',
        body: { ...body, expectedUpdatedAt: s.updatedAt },
      });
      toast({ title: success, tone: 'success' });
      router.refresh();
    } catch (err) {
      toast({ title: describeError(err).message, tone: 'danger' });
    }
  }

  async function remove(s: SavedSearchDto) {
    if (!window.confirm(`Delete “${s.name}”? Alerts stop immediately.`)) return;
    try {
      await portalFetch(`/api/v1/saved-searches/${s.id}`, { method: 'DELETE' });
      toast({ title: 'Search deleted', tone: 'success' });
      router.refresh();
    } catch (err) {
      toast({ title: describeError(err).message, tone: 'danger' });
    }
  }

  async function showMatches(s: SavedSearchDto) {
    setMatches((m) => ({ ...m, [s.id]: 'loading' }));
    try {
      const result = await portalFetch<SavedSearchMatchesDto>(
        `/api/v1/saved-searches/${s.id}/matches`,
      );
      setMatches((m) => ({ ...m, [s.id]: result }));
    } catch (err) {
      toast({ title: describeError(err).message, tone: 'danger' });
      setMatches((m) => ({ ...m, [s.id]: undefined }));
    }
  }

  const describe = (s: SavedSearchDto) => {
    const c = s.criteria;
    const parts: string[] = [];
    if (c.listingKinds.length) parts.push(c.listingKinds.map(humanize).join('/'));
    if (c.propertyKinds.length) parts.push(c.propertyKinds.map(humanize).join(', '));
    if (c.minPriceKobo || c.maxPriceKobo)
      parts.push(
        `${c.minPriceKobo ? koboToNaira(c.minPriceKobo, { whole: true }) : '₦0'} – ${c.maxPriceKobo ? koboToNaira(c.maxPriceKobo, { whole: true }) : 'any'}`,
      );
    if (c.minAreaM2 || c.maxAreaM2) parts.push(`${c.minAreaM2 ?? 0}–${c.maxAreaM2 ?? '∞'} m²`);
    if (c.marketIds.length)
      parts.push(
        c.marketIds.map((id) => markets.find((m) => m.id === id)?.name ?? 'market').join(', '),
      );
    if (c.stateIds.length)
      parts.push(
        c.stateIds.map((id) => states.find((m) => m.id === id)?.name ?? 'state').join(', '),
      );
    if (c.requireTenureDisclosed) parts.push('tenure disclosed');
    if (c.requireTitleDisclosure) parts.push('title disclosure');
    if (c.requiredVerificationChecks.length)
      parts.push(`verified: ${c.requiredVerificationChecks.map(humanize).join(', ')}`);
    if (c.keywords) parts.push(`“${c.keywords}”`);
    return parts.join(' · ');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          Alerts announce a newly published listing once per search, in-app and by email.
        </p>
        {canManage ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            New saved search
          </Button>
        ) : (
          <p className="text-sm text-fg-muted">{cannotManageReason}</p>
        )}
      </div>
      {searches.length === 0 ? (
        <EmptyState
          title="No saved searches"
          description="Save what you are looking for (type, budget, area, locations, disclosures and verification) and we will tell you when a matching listing is published."
        />
      ) : (
        searches.map((s) => {
          const m = matches[s.id];
          return (
            <Card key={s.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>{s.name}</CardTitle>
                    <CardDescription>{describe(s)}</CardDescription>
                  </div>
                  <Badge tone={s.alertsEnabled ? 'success' : 'neutral'}>
                    {s.alertsEnabled ? 'Alerts on' : 'Alerts off'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-xs text-fg-muted">
                  Saved {formatDateTimeLabel(s.createdAt, zone)}
                  {s.alertsEnabled && s.lastRunAt
                    ? ` · alerts checked ${formatDateTimeLabel(s.lastRunAt, zone)}`
                    : ''}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  {canManage ? (
                    <Switch
                      checked={s.alertsEnabled}
                      label="Alerts"
                      onCheckedChange={(v) =>
                        void patch(s, { alertsEnabled: v }, v ? 'Alerts enabled' : 'Alerts paused')
                      }
                    />
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void showMatches(s)}
                    loading={m === 'loading'}
                  >
                    Show current matches
                  </Button>
                  {canManage ? (
                    <Button size="sm" variant="ghost" onClick={() => void remove(s)}>
                      Delete
                    </Button>
                  ) : null}
                </div>
                {m && m !== 'loading' ? (
                  m.items.length === 0 ? (
                    <p className="text-fg-muted">
                      No published listing matches today ({m.evaluated} evaluated).
                    </p>
                  ) : (
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {m.items.map((l) => (
                        <li
                          key={l.id}
                          className="flex flex-wrap items-center justify-between gap-2 p-2"
                        >
                          <a
                            href={`/properties/${l.slug}`}
                            className="font-medium text-primary underline"
                          >
                            {l.title}
                          </a>
                          <span className="text-xs text-fg-muted">
                            {humanize(l.kind)} ·{' '}
                            {l.priceKobo
                              ? koboToNaira(l.priceKobo, { whole: true })
                              : 'price not disclosed'}
                            {l.areaM2 ? ` · ${l.areaM2} m²` : ''}
                            {l.marketName ? ` · ${l.marketName}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </CardContent>
            </Card>
          );
        })
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="New saved search"
          size="md"
          description="Leave a field empty when it does not matter. A listing that does not disclose its price or area never matches a price or area bound."
        >
          <div className="space-y-3">
            {error ? (
              <ErrorState
                title="Could not save"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field label="Name" required>
              {({ id }) => (
                <Input
                  id={id}
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Listing type</legend>
              <div className="flex flex-wrap gap-3">
                {KINDS.map((k) => (
                  <label key={k} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={kinds.includes(k)}
                      onChange={() => toggle(kinds, setKinds, k)}
                    />{' '}
                    {humanize(k)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Property type</legend>
              <div className="flex flex-wrap gap-3">
                {PROPERTY_KINDS.map((k) => (
                  <label key={k} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={propertyKinds.includes(k)}
                      onChange={() => toggle(propertyKinds, setPropertyKinds, k)}
                    />{' '}
                    {humanize(k)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Minimum price (₦)">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={minPrice}
                    onChange={(e) => setMinPrice(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Maximum price (₦)">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={maxPrice}
                    onChange={(e) => setMaxPrice(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Minimum area (m²)">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={minArea}
                    onChange={(e) => setMinArea(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Maximum area (m²)">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={maxArea}
                    onChange={(e) => setMaxArea(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Markets"
              hint="Hold Ctrl/Cmd to choose several. A listing matches when its market or its state is chosen."
            >
              {({ id }) => (
                <NativeSelect
                  id={id}
                  multiple
                  value={marketIds}
                  onChange={(e) => setMarketIds([...e.target.selectedOptions].map((o) => o.value))}
                >
                  {markets.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="States">
              {({ id }) => (
                <NativeSelect
                  id={id}
                  multiple
                  value={stateIds}
                  onChange={(e) => setStateIds([...e.target.selectedOptions].map((o) => o.value))}
                >
                  {states.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <div className="flex flex-wrap gap-4">
              <Switch checked={tenure} onCheckedChange={setTenure} label="Tenure disclosed" />
              <Switch checked={title} onCheckedChange={setTitle} label="Title disclosure present" />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Verification checks in scope</legend>
              <div className="flex flex-wrap gap-3">
                {CHECKS.map((c) => (
                  <label key={c.value} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={checks.includes(c.value)}
                      onChange={() => toggle(checks, setChecks, c.value)}
                    />{' '}
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Keywords" hint="All words must appear in the listing title.">
              {({ id }) => (
                <Input
                  id={id}
                  maxLength={120}
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                />
              )}
            </Field>
            <Switch
              checked={alerts}
              onCheckedChange={setAlerts}
              label="Alert me when a matching listing is published"
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => void create()}
                loading={busy}
                disabled={name.trim().length < 2}
              >
                Save search
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
