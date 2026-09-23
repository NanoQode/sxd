'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, Field, Input, NativeSelect, Switch } from '@simplexd/ui';
import type { ExplorerFilters } from '@simplexd/contracts';
import {
  AMENITY_PREFERENCES,
  ASSET_TYPES,
  EVIDENCE_FRESHNESS,
  FLOOD_PREFERENCES,
  OBJECTIVES,
  OBJECTIVE_LABELS,
  QUALITY_SPECS,
  RISK_TOLERANCES,
  TEAM_PREFERENCES,
  ZONES,
  ZONE_LABELS,
  countActiveFilters,
  humanizeKey,
  type AmenityPreference,
  type Zone,
} from '@/lib/explorer';
import { useExplorer } from './explorer-context';

/**
 * Every filter from the explorer contract. Unknown is a real value: the
 * "Include unknown" switch and the "Unknown is fine" preference keep markets
 * without evidence visible instead of silently dropping them.
 */

const AMENITY_LABELS: Record<AmenityPreference, string> = {
  any: 'Any',
  preferred: 'Preferred',
  required: 'Required (unknown shown only if allowed)',
  unknown_ok: 'Present or unknown is fine',
};

const FLOOD_LABELS: Record<ExplorerFilters['floodExposure'], string> = {
  any: 'Any',
  low_only: 'Assessed low only (unknown is not low)',
  exclude_high: 'Exclude high or official alerts',
  unknown_ok: 'Low or unknown',
};

const TEAM_LABELS: Record<ExplorerFilters['serviceTeamAvailability'], string> = {
  any: 'Any',
  available_only: 'Service team available',
  available_or_on_request: 'Available, limited or on request',
};

function SelectFilter<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
  hint,
  allowNone,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  onChange: (value: T | null) => void;
  hint?: ReactNode;
  allowNone?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => (
        <NativeSelect
          id={id}
          aria-describedby={describedBy}
          value={value ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === '' ? null : (next as T));
          }}
        >
          {allowNone !== undefined ? <option value="">{allowNone}</option> : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {labels?.[option] ?? humanizeKey(option)}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

/** Numeric input committed on blur/Enter or after a pause, so typing never thrashes the URL. */
function NumberFilter({
  label,
  value,
  onCommit,
  unit,
  hint,
  min = 0,
  step,
}: {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  unit?: string;
  hint?: ReactNode;
  min?: number;
  step?: number;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  const commit = () => {
    const cleaned = text.replace(/[,\s₦]/g, '');
    if (cleaned === '') {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(cleaned);
    if (Number.isFinite(n) && n >= min) {
      if (n !== value) onCommit(n);
    } else {
      setText(value === null ? '' : String(value));
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(commit, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <Field label={unit ? `${label} (${unit})` : label} hint={hint}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          inputMode="decimal"
          step={step}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
          placeholder="Any"
        />
      )}
    </Field>
  );
}

export function FilterPanel({ compact = false }: { compact?: boolean }) {
  const { filters, setFilters, resetFilters, query, setQuery, stateOptions, rows, totalMarkets, markets } =
    useExplorer();
  const [search, setSearch] = useState(query);
  useEffect(() => setSearch(query), [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search !== query) setQuery(search);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query, setQuery]);

  const [statesOpen, setStatesOpen] = useState(false);
  const statesId = useId();
  const zonesId = useId();
  const active = countActiveFilters(filters);
  const matching = rows.organic.length + rows.sponsored.length;

  const toggleZone = (zone: Zone) => {
    const set = new Set(filters.preferredZones);
    if (set.has(zone)) set.delete(zone);
    else set.add(zone);
    setFilters({ preferredZones: [...set] });
  };
  const toggleState = (id: string) => {
    const set = new Set(filters.preferredStateIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setFilters({ preferredStateIds: [...set] });
  };

  return (
    <form
      className="space-y-4"
      aria-label="Filters"
      onSubmit={(event) => event.preventDefault()}
      data-testid="filter-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <p aria-live="polite" className="text-sm text-fg-muted">
          {markets.isLoading ? 'Loading…' : `${matching} of ${totalMarkets} markets match`}
        </p>
        <Button variant="ghost" onClick={resetFilters} disabled={active === 0 && query === ''}>
          Reset
        </Button>
      </div>

      <Field label="Search markets">
        {({ id }) => (
          <Input
            id={id}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="City, state or alias"
            autoComplete="off"
          />
        )}
      </Field>

      <SelectFilter
        label="Objective"
        value={filters.objective}
        options={OBJECTIVES}
        labels={OBJECTIVE_LABELS}
        onChange={(objective) => objective && setFilters({ objective })}
      />

      <NumberFilter
        label="Total budget"
        unit="₦"
        value={filters.totalBudgetNaira}
        onCommit={(totalBudgetNaira) => setFilters({ totalBudgetNaira })}
        hint="Applied only where a market has valid cost evidence; otherwise the market stays visible with its budget unassessed."
      />

      <fieldset>
        <legend id={zonesId} className="mb-1 text-sm font-medium">
          Preferred regions
        </legend>
        <ul className="grid grid-cols-2 gap-1" aria-labelledby={zonesId}>
          {ZONES.map((zone) => {
            const checked = filters.preferredZones.includes(zone);
            return (
              <li key={zone}>
                <label className="sx-touch flex cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-bg-sunken">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--sx-primary)]"
                    checked={checked}
                    onChange={() => toggleZone(zone)}
                  />
                  {ZONE_LABELS[zone]}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div>
        <button
          type="button"
          className="sx-touch flex w-full items-center justify-between text-sm font-medium"
          aria-expanded={statesOpen}
          aria-controls={statesId}
          onClick={() => setStatesOpen((open) => !open)}
        >
          <span>
            Preferred states
            {filters.preferredStateIds.length > 0 ? ` (${filters.preferredStateIds.length})` : ''}
          </span>
          <span aria-hidden="true">{statesOpen ? '−' : '+'}</span>
        </button>
        {statesOpen ? (
          <ul id={statesId} className="mt-1 max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
            {stateOptions.length === 0 ? (
              <li className="p-2 text-sm text-fg-muted">States load with the market list.</li>
            ) : null}
            {stateOptions.map((state) => (
              <li key={state.id}>
                <label className="sx-touch flex cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-bg-sunken">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--sx-primary)]"
                    checked={filters.preferredStateIds.includes(state.id)}
                    onChange={() => toggleState(state.id)}
                  />
                  <span className="flex-1">{state.name}</span>
                  <span className="text-xs text-fg-muted">{ZONE_LABELS[state.geopoliticalZone]}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {!compact ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <NumberFilter label="Land area" unit="m²" value={filters.landAreaM2} onCommit={(landAreaM2) => setFilters({ landAreaM2 })} />
            <NumberFilter label="Floor area" unit="m²" value={filters.floorAreaM2} onCommit={(floorAreaM2) => setFilters({ floorAreaM2 })} />
          </div>
          <SelectFilter label="Asset type" value={filters.assetType} options={ASSET_TYPES} onChange={(assetType) => setFilters({ assetType })} allowNone="Any" />
          <div className="grid grid-cols-2 gap-3">
            <NumberFilter label="Bedrooms or units" value={filters.bedroomsOrUnits} onCommit={(n) => setFilters({ bedroomsOrUnits: n === null ? null : Math.round(n) })} step={1} />
            <NumberFilter label="Target completion" unit="months" value={filters.targetCompletionMonths} onCommit={(n) => setFilters({ targetCompletionMonths: n === null ? null : Math.max(1, Math.round(n)) })} min={1} step={1} />
          </div>
          <SelectFilter label="Quality specification" value={filters.qualitySpecification} options={QUALITY_SPECS} onChange={(qualitySpecification) => setFilters({ qualitySpecification })} allowNone="Any" />
          <NumberFilter
            label="Minimum projected net yield"
            unit="%"
            value={filters.minProjectedNetYieldPercent}
            onCommit={(minProjectedNetYieldPercent) => setFilters({ minProjectedNetYieldPercent })}
            hint="Compared against evidence or your assumptions; markets with unknown yield stay visible while unknown is allowed."
          />
          <SelectFilter label="Risk tolerance" value={filters.riskTolerance} options={RISK_TOLERANCES} onChange={(riskTolerance) => riskTolerance && setFilters({ riskTolerance })} />
          <SelectFilter
            label="Evidence freshness"
            value={filters.evidenceFreshness}
            options={EVIDENCE_FRESHNESS}
            labels={{ fresh_only: 'Fresh evidence only', include_stale: 'Include stale evidence (inspectable, not ranked)' }}
            onChange={(evidenceFreshness) => evidenceFreshness && setFilters({ evidenceFreshness })}
          />
        </>
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2">
        <label htmlFor="filter-include-unknown" className="text-sm">
          <span className="font-medium">Include unknown</span>
          <span className="block text-xs text-fg-muted">
            Keep markets whose evidence is unknown for the optional criteria below. Unknown is never
            treated as low risk.
          </span>
        </label>
        <Switch id="filter-include-unknown" checked={filters.includeUnknown} onCheckedChange={(includeUnknown) => setFilters({ includeUnknown })} />
      </div>

      {!compact ? (
        <details className="rounded-md border border-border p-2" open={active > 0}>
          <summary className="sx-touch flex cursor-pointer items-center gap-2 text-sm font-medium">
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" /> Optional criteria
          </summary>
          <div className="mt-2 space-y-3">
            {(
              [
                ['power', 'Power provision'],
                ['water', 'Water provision'],
                ['internet', 'Internet'],
                ['transport', 'Transport access'],
                ['schools', 'Schools'],
                ['hospitals', 'Hospitals'],
                ['soilInvestigation', 'Soil investigations'],
              ] as const
            ).map(([key, label]) => (
              <SelectFilter
                key={key}
                label={label}
                value={filters[key]}
                options={AMENITY_PREFERENCES}
                labels={AMENITY_LABELS}
                onChange={(value) => value && setFilters({ [key]: value })}
              />
            ))}
            <SelectFilter label="Flood exposure" value={filters.floodExposure} options={FLOOD_PREFERENCES} labels={FLOOD_LABELS} onChange={(floodExposure) => floodExposure && setFilters({ floodExposure })} />
            <SelectFilter label="Service team availability" value={filters.serviceTeamAvailability} options={TEAM_PREFERENCES} labels={TEAM_LABELS} onChange={(serviceTeamAvailability) => serviceTeamAvailability && setFilters({ serviceTeamAvailability })} />
          </div>
        </details>
      ) : null}
    </form>
  );
}

/** Mobile: the same filters in an accessible bottom sheet. */
export function FilterSheet() {
  const { filters, query } = useExplorer();
  const [open, setOpen] = useState(false);
  const active = countActiveFilters(filters) + (query === '' ? 0 : 1);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        Filters{active > 0 ? ` (${active})` : ''}
      </Button>
      <DialogContent size="sheet" title="Filters" description="Unknown is a real value; markets without evidence stay visible while unknown is allowed.">
        <FilterPanel />
        <div className="mt-4">
          <Button className="w-full" onClick={() => setOpen(false)}>
            Show results
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
