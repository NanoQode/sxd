'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseAsBoolean, parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import type { AdminMarketRow } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../_components/action-dialog';
import { Pagination } from '../../_components/pagination';
import { fmtDate } from '../../_components/bits';
import { AVAILABILITY, PUBLICATION_STATES, ZONES, humanize } from '../_lib/params';

interface BulkOutcome {
  id: string;
  slug: string;
  name: string;
  currentState: string;
  outcome: 'will_change' | 'changed' | 'skipped' | 'denied';
  detail: string;
}

interface SavedView {
  name: string;
  search: string;
}

const VIEWS_KEY = 'sx-admin-market-views';

function readViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    return raw ? (JSON.parse(raw) as SavedView[]) : [];
  } catch {
    return [];
  }
}

function writeViews(views: SavedView[]): void {
  try {
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* per-viewer convenience only */
  }
}

const filterParsers = {
  q: parseAsString.withDefault(''),
  stateId: parseAsString.withDefault(''),
  zone: parseAsString.withDefault(''),
  publicationState: parseAsString.withDefault(''),
  serviceAvailability: parseAsString.withDefault(''),
  pendingReview: parseAsBoolean.withDefault(false),
  sort: parseAsString.withDefault('name'),
  order: parseAsString.withDefault('asc'),
  page: parseAsInteger.withDefault(1),
};

export function MarketsTable({
  result,
  states,
  canPublish,
  invalidQuery,
}: {
  result: { items: AdminMarketRow[]; total: number; page: number; pageSize: number };
  states: Array<{ id: string; name: string; geopoliticalZone: string }>;
  canPublish: boolean;
  invalidQuery: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [filters, setFilters] = useQueryStates(filterParsers, { shallow: false });
  // The search text is keyed to the URL value so navigation (saved views) resets it without an effect.
  const [searchState, setSearchState] = useState({ q: filters.q, text: filters.q });
  const search = searchState.q === filters.q ? searchState.text : filters.q;
  const setSearch = (text: string) => setSearchState({ q: filters.q, text });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{
    action: 'publish' | 'unpublish';
    outcomes: BulkOutcome[] | null;
    error: string | null;
  } | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');

  const refreshViews = () => setViews(readViews());
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== filters.q) void setFilters({ q: search || null, page: 1 });
    }, 300);
    return () => clearTimeout(t);
  }, [search, filters.q, setFilters]);

  const allOnPage = result.items.length > 0 && result.items.every((m) => selected.has(m.id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) result.items.forEach((m) => next.delete(m.id));
      else result.items.forEach((m) => next.add(m.id));
      return next;
    });
  }

  async function openBulk(action: 'publish' | 'unpublish') {
    setBulk({ action, outcomes: null, error: null });
    try {
      const res = await apiFetch<{ outcomes: BulkOutcome[] }>('/api/v1/admin/markets/bulk', {
        method: 'POST',
        body: { action, marketIds: [...selected], reason: 'preview', preview: true },
      });
      setBulk({ action, outcomes: res.outcomes, error: null });
    } catch (err) {
      setBulk({ action, outcomes: [], error: errorMessage(err) });
    }
  }

  async function applyBulk(reason: string) {
    if (!bulk) return;
    const res = await apiFetch<{ outcomes: BulkOutcome[] }>('/api/v1/admin/markets/bulk', {
      method: 'POST',
      body: { action: bulk.action, marketIds: [...selected], reason, preview: false },
    });
    const changed = res.outcomes.filter((o) => o.outcome === 'changed').length;
    toast({
      title: `${changed} market${changed === 1 ? '' : 's'} ${bulk.action === 'publish' ? 'published' : 'unpublished'}`,
      tone: 'success',
    });
    setSelected(new Set());
    router.refresh();
  }

  function currentSearch(): string {
    if (typeof window === 'undefined') return '';
    return window.location.search;
  }

  function saveView() {
    const name = viewName.trim();
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, search: currentSearch() }];
    setViews(next);
    writeViews(next);
    setSaveOpen(false);
    setViewName('');
    toast({ title: `View "${name}" saved on this device` });
  }

  function applyView(name: string) {
    const view = views.find((v) => v.name === name);
    if (!view) return;
    router.push(`/admin/market-data${view.search}`);
  }

  function removeView(name: string) {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeViews(next);
  }

  const columns = useMemo<Column<AdminMarketRow>[]>(() => {
    const cols: Column<AdminMarketRow>[] = [];
    if (canPublish) {
      cols.push({
        key: 'select',
        header: (
          <input
            type="checkbox"
            aria-label="Select all markets on this page"
            checked={allOnPage}
            onChange={toggleAll}
            className="h-4 w-4 accent-[var(--sx-primary)]"
          />
        ),
        mobileLabel: 'Select',
        className: 'w-8',
        cell: (m) => (
          <input
            type="checkbox"
            aria-label={`Select ${m.name}`}
            checked={selected.has(m.id)}
            onChange={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(m.id)) next.delete(m.id);
                else next.add(m.id);
                return next;
              })
            }
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 accent-[var(--sx-primary)]"
          />
        ),
      });
    }
    cols.push(
      {
        key: 'name',
        header: 'Market',
        cell: (m) => (
          <div className="min-w-0">
            <Link
              href={`/admin/market-data/markets/${m.id}`}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {m.name}
            </Link>
            <p className="truncate text-xs text-fg-muted">
              {m.slug}
              {m.aliases.length > 0 ? ` · aka ${m.aliases.join(', ')}` : ''}
              {m.mergedIntoMarketId ? ' · merged' : ''}
            </p>
          </div>
        ),
      },
      { key: 'state', header: 'State', cell: (m) => `${m.stateName} (${m.geopoliticalZone})` },
      {
        key: 'publication',
        header: 'Publication',
        cell: (m) => <StatusBadge status={m.publicationState} />,
      },
      {
        key: 'availability',
        header: 'Service availability',
        cell: (m) => (
          <Badge tone={m.serviceAvailability === 'available' ? 'success' : 'neutral'}>
            {humanize(m.serviceAvailability)}
          </Badge>
        ),
      },
      {
        key: 'evidence',
        header: 'Evidence',
        cell: (m) => (
          <span className="text-xs text-fg-muted">
            {m.localObservations} local · {m.pendingReviews} pending · {m.openResearchTasks} tasks
          </span>
        ),
      },
      {
        key: 'version',
        header: 'Version',
        hideOnMobile: true,
        cell: (m) => <span className="font-mono text-xs">v{m.version}</span>,
      },
      {
        key: 'updated',
        header: 'Updated',
        hideOnMobile: true,
        cell: (m) => <span className="text-xs text-fg-muted">{fmtDate(m.updatedAt)}</span>,
      },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPublish, allOnPage, selected, result.items]);

  return (
    <div className="space-y-4">
      {invalidQuery ? (
        <Alert tone="warning" title="Some filters in the URL were not understood">
          The list shows the default view instead.
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg-elevated p-3 sm:grid-cols-2 lg:grid-cols-6">
        <Field label="Search" className="lg:col-span-2">
          {({ id }) => (
            <Input
              id={id}
              placeholder="Name, slug or alias"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </Field>
        <Field label="State">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.stateId}
              onChange={(e) => setFilters({ stateId: e.target.value || null, page: 1 })}
            >
              <option value="">All states</option>
              {states.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Zone">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.zone}
              onChange={(e) => setFilters({ zone: e.target.value || null, page: 1 })}
            >
              <option value="">All zones</option>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Publication">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.publicationState}
              onChange={(e) => setFilters({ publicationState: e.target.value || null, page: 1 })}
            >
              <option value="">Any</option>
              {PUBLICATION_STATES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Availability">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.serviceAvailability}
              onChange={(e) => setFilters({ serviceAvailability: e.target.value || null, page: 1 })}
            >
              <option value="">Any</option>
              {AVAILABILITY.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--sx-primary)]"
            checked={filters.pendingReview}
            onChange={(e) => setFilters({ pendingReview: e.target.checked ? true : null, page: 1 })}
          />
          Pending review only
        </label>
        <Field label="Sort">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={`${filters.sort}:${filters.order}`}
              onChange={(e) => {
                const [sort, order] = e.target.value.split(':');
                void setFilters({ sort: sort ?? 'name', order: order ?? 'asc', page: 1 });
              }}
            >
              <option value="name:asc">Name A–Z</option>
              <option value="name:desc">Name Z–A</option>
              <option value="state:asc">State</option>
              <option value="publicationState:asc">Publication state</option>
              <option value="updatedAt:desc">Recently updated</option>
              <option value="displayOrder:asc">Display order</option>
            </NativeSelect>
          )}
        </Field>
        <div className="flex flex-wrap items-end gap-2 lg:col-span-3">
          <Field label="Saved views" className="min-w-40 flex-1">
            {({ id }) => (
              <NativeSelect
                id={id}
                value=""
                onFocus={refreshViews}
                onChange={(e) => e.target.value && applyView(e.target.value)}
              >
                <option value="">Apply a saved view…</option>
                {views.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button
            variant="secondary"
            onClick={() => {
              refreshViews();
              setSaveOpen(true);
            }}
          >
            Save current view
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setFilters({
                q: null,
                stateId: null,
                zone: null,
                publicationState: null,
                serviceAvailability: null,
                pendingReview: null,
                sort: null,
                order: null,
                page: null,
              })
            }
          >
            Clear
          </Button>
        </div>
      </div>

      {canPublish ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-muted">{selected.size} selected</span>
          <Button size="sm" disabled={selected.size === 0} onClick={() => openBulk('publish')}>
            Publish selected
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.size === 0}
            onClick={() => openBulk('unpublish')}
          >
            Unpublish selected
          </Button>
          {selected.size > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          ) : null}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={result.items}
        rowKey={(m) => m.id}
        rowLabel={(m) => m.name}
        caption="Markets"
        emptyMessage="No markets match these filters."
        onRowClick={(m) => router.push(`/admin/market-data/markets/${m.id}`)}
      />
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} />

      <ActionDialog
        open={bulk !== null}
        onOpenChange={(o) => !o && setBulk(null)}
        title={
          bulk?.action === 'publish' ? 'Publish selected markets' : 'Unpublish selected markets'
        }
        description="Review the affected rows before confirming. Every change is audited with your reason."
        confirmLabel={bulk?.action === 'publish' ? 'Publish' : 'Unpublish'}
        tone={bulk?.action === 'unpublish' ? 'danger' : 'primary'}
        requireReason
        onConfirm={applyBulk}
      >
        {bulk?.error ? <Alert tone="danger">{bulk.error}</Alert> : null}
        {bulk?.outcomes === null ? (
          <p className="text-sm text-fg-muted">Preparing preview…</p>
        ) : null}
        {bulk?.outcomes && bulk.outcomes.length > 0 ? (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm">
            {bulk.outcomes.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 truncate">{o.name || o.id}</span>
                <Badge tone={o.outcome === 'will_change' ? 'success' : 'neutral'}>
                  {o.outcome === 'will_change' ? o.detail : `skipped: ${o.detail}`}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </ActionDialog>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent
          title="Save this view"
          description="Saved on this device only; the URL itself is shareable."
          size="sm"
        >
          <Field label="View name" required>
            {({ id }) => (
              <Input id={id} value={viewName} onChange={(e) => setViewName(e.target.value)} />
            )}
          </Field>
          {views.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {views.map((v) => (
                <li key={v.name} className="flex items-center justify-between gap-2">
                  <span>{v.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => removeView(v.name)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveView} disabled={!viewName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
