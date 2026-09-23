'use client';

import { parseAsString, useQueryStates } from 'nuqs';
import { useState } from 'react';
import type { AuditEventDto, AuditListQuery } from '@simplexd/contracts';
import { Alert, Button, Field, Input, NativeSelect } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { AuditTable } from '../_components/audit-table';

const parsers = {
  actorUserId: parseAsString.withDefault(''),
  entityType: parseAsString.withDefault(''),
  entityId: parseAsString.withDefault(''),
  action: parseAsString.withDefault(''),
  from: parseAsString.withDefault(''),
  to: parseAsString.withDefault(''),
};

export function AuditLog({
  initial,
  query,
  options,
}: {
  initial: { items: AuditEventDto[]; nextCursor: string | null };
  query: AuditListQuery;
  options: { entityTypes: string[]; actions: string[] };
}) {
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false });
  // Extra pages are keyed to the server-rendered page so a new filter result discards them.
  const [loaded, setLoaded] = useState<{ base: typeof initial; more: AuditEventDto[]; cursor: string | null }>({ base: initial, more: [], cursor: initial.nextCursor });
  const current = loaded.base === initial ? loaded : { base: initial, more: [], cursor: initial.nextCursor };
  const items = [...initial.items, ...current.more];
  const cursor = current.cursor;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && k !== 'cursor' && k !== 'limit') qs.set(k, String(v));
      qs.set('cursor', cursor);
      const page = await apiFetch<{ items: AuditEventDto[]; nextCursor: string | null }>(`/api/v1/admin/audit?${qs.toString()}`);
      setLoaded({ base: initial, more: [...current.more, ...page.items], cursor: page.nextCursor });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const toIso = (v: string, end: boolean) => (v ? new Date(`${v}T${end ? '23:59:59' : '00:00:00'}Z`).toISOString() : null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg-elevated p-3 sm:grid-cols-2 lg:grid-cols-6">
        <Field label="Actor user id">{({ id }) => <Input id={id} defaultValue={filters.actorUserId} onBlur={(e) => setFilters({ actorUserId: e.target.value || null })} />}</Field>
        <Field label="Entity type">
          {({ id }) => (
            <NativeSelect id={id} value={filters.entityType} onChange={(e) => setFilters({ entityType: e.target.value || null })}>
              <option value="">Any</option>
              {options.entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label="Entity id">{({ id }) => <Input id={id} defaultValue={filters.entityId} onBlur={(e) => setFilters({ entityId: e.target.value || null })} />}</Field>
        <Field label="Action">
          {({ id }) => (
            <NativeSelect id={id} value={filters.action} onChange={(e) => setFilters({ action: e.target.value || null })}>
              <option value="">Any</option>
              {options.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label="From">{({ id }) => <Input id={id} type="date" defaultValue={filters.from.slice(0, 10)} onChange={(e) => setFilters({ from: toIso(e.target.value, false) })} />}</Field>
        <Field label="To">{({ id }) => <Input id={id} type="date" defaultValue={filters.to.slice(0, 10)} onChange={(e) => setFilters({ to: toIso(e.target.value, true) })} />}</Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <AuditTable items={items} caption="Audit log" />
      {cursor ? <Button variant="secondary" onClick={loadMore} loading={busy} loadingLabel="Loading">Load more</Button> : <p className="text-xs text-fg-muted">End of results.</p>}
    </div>
  );
}
