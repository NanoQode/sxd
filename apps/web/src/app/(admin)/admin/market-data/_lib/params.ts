/** Drops empty strings and arrays so optional enum filters parse cleanly. */
export function cleanSearchParams(
  params: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined && value !== '') out[k] = value;
  }
  return out;
}

export const PUBLICATION_STATES = [
  'draft',
  'in_review',
  'published',
  'unpublished',
  'archived',
] as const;
export const ZONES = ['NC', 'NE', 'NW', 'SE', 'SS', 'SW'] as const;
export const AVAILABILITY = [
  'pending_operations_confirmation',
  'available',
  'limited',
  'on_request',
  'unavailable',
] as const;
export const REVIEW_STATUSES = [
  'source_read_pending_business_review',
  'verified',
  'disputed',
  'rejected',
  'superseded',
  'stale',
] as const;
export const GEOGRAPHY_LEVELS = [
  'country',
  'state_or_fct',
  'city',
  'neighborhood',
  'site',
] as const;
export const STATISTICS = [
  'median',
  'mean',
  'min',
  'max',
  'range',
  'count',
  'categorical',
  'quote',
  'single_observation',
] as const;
export const NUMERIC_REPRESENTATIONS = [
  'whole_naira_not_kobo',
  'kobo',
  'percent',
  'days',
  'count',
  'text',
  'other',
] as const;

export const humanize = (v: string | null | undefined): string =>
  v ? v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—';
