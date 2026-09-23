'use client';

import { parseAsBoolean, parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { useEffect, useState } from 'react';
import type { ObservationListQuery } from '@simplexd/contracts';
import { Alert, Button, Field, Input, NativeSelect } from '@simplexd/ui';
import type { AdminObservationDto } from '@/server/admin/market-data/observations';
import { Pagination } from '../../_components/pagination';
import { ObservationTable } from '../_components/observation-table';
import { GEOGRAPHY_LEVELS, PUBLICATION_STATES, REVIEW_STATUSES, humanize } from '../_lib/params';

const parsers = {
  q: parseAsString.withDefault(''),
  reviewStatus: parseAsString.withDefault(''),
  publicationState: parseAsString.withDefault(''),
  geographyLevel: parseAsString.withDefault(''),
  metric: parseAsString.withDefault(''),
  marketId: parseAsString.withDefault(''),
  rankEligible: parseAsString.withDefault(''),
  pendingOnly: parseAsBoolean.withDefault(false),
  page: parseAsInteger.withDefault(1),
};

export function ObservationsQueue({
  result,
  query,
  metrics,
  markets,
  actorId,
  canPublish,
  canEdit,
}: {
  result: { items: AdminObservationDto[]; total: number; page: number; pageSize: number };
  query: ObservationListQuery;
  metrics: string[];
  markets: Array<{ id: string; name: string }>;
  actorId: string;
  canPublish: boolean;
  canEdit: boolean;
}) {
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false });
  const [searchState, setSearchState] = useState({ q: filters.q, text: filters.q });
  const search = searchState.q === filters.q ? searchState.text : filters.q;
  const setSearch = (text: string) => setSearchState({ q: filters.q, text });
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== filters.q) void setFilters({ q: search || null, page: 1 });
    }, 300);
    return () => clearTimeout(t);
  }, [search, filters.q, setFilters]);
  const showingPending = query.pendingOnly;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg-elevated p-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search">
          {({ id }) => (
            <Input
              id={id}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Metric, cohort, source, market"
            />
          )}
        </Field>
        <Field label="Review status">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.reviewStatus}
              onChange={(e) =>
                setFilters({
                  reviewStatus: e.target.value || null,
                  pendingOnly: e.target.value ? false : null,
                  page: 1,
                })
              }
            >
              <option value="">Any</option>
              {REVIEW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s === 'source_read_pending_business_review' ? 'pending review' : s)}
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
        <Field label="Geography">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.geographyLevel}
              onChange={(e) => setFilters({ geographyLevel: e.target.value || null, page: 1 })}
            >
              <option value="">Any level</option>
              {GEOGRAPHY_LEVELS.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Metric">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.metric}
              onChange={(e) => setFilters({ metric: e.target.value || null, page: 1 })}
            >
              <option value="">Any metric</option>
              {metrics.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Market">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.marketId}
              onChange={(e) => setFilters({ marketId: e.target.value || null, page: 1 })}
            >
              <option value="">Any market</option>
              {markets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Rank eligibility">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={filters.rankEligible}
              onChange={(e) => setFilters({ rankEligible: e.target.value || null, page: 1 })}
            >
              <option value="">Any</option>
              <option value="true">Rank-eligible</option>
              <option value="false">Not rank-eligible</option>
            </NativeSelect>
          )}
        </Field>
        <div className="flex items-end gap-2">
          <Button
            variant={showingPending ? 'primary' : 'secondary'}
            onClick={() =>
              setFilters({
                pendingOnly: showingPending ? false : true,
                reviewStatus: null,
                page: 1,
              })
            }
          >
            {showingPending ? 'Showing pending only' : 'Pending only'}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setFilters({
                q: null,
                reviewStatus: null,
                publicationState: null,
                geographyLevel: null,
                metric: null,
                marketId: null,
                rankEligible: null,
                pendingOnly: false,
                page: null,
              })
            }
          >
            Clear
          </Button>
        </div>
      </div>
      {showingPending && result.total === 0 ? (
        <Alert tone="success" title="Nothing awaiting review">
          Every current interpretation has been reviewed.
        </Alert>
      ) : null}
      <ObservationTable
        items={result.items}
        actorId={actorId}
        canPublish={canPublish}
        canEdit={canEdit}
        caption="Observation queue"
        emptyMessage="No observations match these filters."
      />
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
