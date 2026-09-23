import { z } from 'zod';
import {
  comparisonResponseSchema,
  marketDetailSchema,
  marketGeoJsonSchema,
  marketListResponseSchema,
  recommendationResponseSchema,
  scenarioDtoSchema,
  type comparisonRequestSchema,
  type scenarioUpdateSchema,
  type CalculatorRunRequest,
  type ComparisonResponse,
  type MarketDetailDto,
  type MarketGeoJson,
  type MarketListQuery,
  type MarketListResponse,
  type RecommendationRequest,
  type RecommendationResponse,
  type ScenarioCreate,
  type ScenarioDto,
} from '@simplexd/contracts';
import { normalizeCalculatorResponse, type CalculatorRunResult } from './calculators';

/**
 * Typed client for the explorer's API calls. Every response is validated with
 * the contract's zod schema (safeParse); a mismatch becomes a `contract`
 * error the UI shows honestly, never a crash or an invented value. Error
 * envelopes `{ error: { code, message, correlationId, retryable } }` are
 * surfaced with their correlation id for support.
 */

export const API_BASE = '/api/v1';

export type ExplorerErrorKind = 'network' | 'http' | 'contract' | 'aborted';

export class ExplorerApiError extends Error {
  readonly kind: ExplorerErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly details: unknown;

  constructor(
    kind: ExplorerErrorKind,
    message: string,
    options: {
      status?: number | null;
      code?: string | null;
      correlationId?: string | null;
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      details?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ExplorerApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.correlationId = options.correlationId ?? null;
    this.retryable = options.retryable ?? kind === 'network';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.details = options.details;
  }
}

export interface ErrorDescription {
  message: string;
  retryable: boolean;
  correlationId: string | null;
  code: string | null;
  status: number | null;
}

/** Human-readable description of any thrown value, for error states. */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof ExplorerApiError) {
    return {
      message: error.message,
      retryable: error.retryable,
      correlationId: error.correlationId,
      code: error.code,
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      retryable: true,
      correlationId: null,
      code: null,
      status: null,
    };
  }
  return {
    message: 'Something went wrong.',
    retryable: true,
    correlationId: null,
    code: null,
    status: null,
  };
}

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    retryable: z.boolean().optional(),
    retryAfterSeconds: z.number().optional(),
    details: z.unknown().optional(),
  }),
});

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    credentials: 'same-origin',
    signal: options.signal,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  try {
    return await fetchImpl(`${API_BASE}${path}`, init);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ExplorerApiError('aborted', 'The request was cancelled.', { retryable: false });
    }
    throw new ExplorerApiError(
      'network',
      'The server could not be reached. Check your connection and try again.',
      { retryable: true },
    );
  }
}

async function readError(res: Response): Promise<ExplorerApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ExplorerApiError('http', e.message, {
      status: res.status,
      code: e.code,
      correlationId: e.correlationId ?? res.headers.get('x-correlation-id'),
      retryable: e.retryable ?? (res.status >= 500 || res.status === 429),
      retryAfterSeconds: e.retryAfterSeconds ?? null,
      details: e.details,
    });
  }
  const generic =
    res.status === 404
      ? 'Not found.'
      : res.status === 401
        ? 'Sign in is required for this action.'
        : res.status === 403
          ? 'You do not have access to this resource.'
          : `The server responded with status ${res.status}.`;
  return new ExplorerApiError('http', generic, {
    status: res.status,
    correlationId: res.headers.get('x-correlation-id'),
    retryable: res.status >= 500 || res.status === 429,
  });
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const res = await send(path, options);
  if (!res.ok) throw await readError(res);
  if (res.status === 204) {
    const empty = schema.safeParse(undefined);
    if (empty.success) return empty.data;
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ExplorerApiError('contract', 'The server returned a response that was not JSON.', {
      status: res.status,
      retryable: false,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ExplorerApiError(
      'contract',
      'The server response did not match the expected shape, so it was not shown.',
      { status: res.status, retryable: false, details: parsed.error.issues.slice(0, 5) },
    );
  }
  return parsed.data;
}

const query = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
};

/* ---------------------------------------------------------------------- */
/* Markets                                                                 */
/* ---------------------------------------------------------------------- */

export function getMarkets(
  params: Partial<MarketListQuery> = {},
  signal?: AbortSignal,
): Promise<MarketListResponse> {
  return request(
    `/markets${query({ ...params, limit: params.limit ?? 100 })}`,
    marketListResponseSchema,
    {
      signal,
    },
  );
}

export function getMarketsGeoJson(signal?: AbortSignal): Promise<MarketGeoJson> {
  return request('/markets/geojson', marketGeoJsonSchema, { signal });
}

export function getMarketDetail(slug: string, signal?: AbortSignal): Promise<MarketDetailDto> {
  return request(`/markets/${encodeURIComponent(slug)}`, marketDetailSchema, { signal });
}

export const stateOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  geopoliticalZone: z.enum(['NC', 'NE', 'NW', 'SE', 'SS', 'SW']),
  isFederalCapital: z.boolean().optional().default(false),
  marketCount: z.number().int().optional().default(0),
});
export type StateOption = z.infer<typeof stateOptionSchema>;

const statesResponseSchema = z
  .union([z.array(stateOptionSchema), z.object({ items: z.array(stateOptionSchema) })])
  .transform((value) => (Array.isArray(value) ? value : value.items));

export function getStates(signal?: AbortSignal): Promise<StateOption[]> {
  return request('/states', statesResponseSchema, { signal });
}

/* ---------------------------------------------------------------------- */
/* Recommendations, comparisons, calculators                               */
/* ---------------------------------------------------------------------- */

export function postRecommendations(
  body: RecommendationRequest,
  signal?: AbortSignal,
): Promise<RecommendationResponse> {
  return request('/recommendations', recommendationResponseSchema, {
    method: 'POST',
    body,
    signal,
  });
}

export type ComparisonRequest = z.input<typeof comparisonRequestSchema>;

export function postComparison(
  body: ComparisonRequest,
  signal?: AbortSignal,
): Promise<ComparisonResponse> {
  return request('/comparisons', comparisonResponseSchema, { method: 'POST', body, signal });
}

export async function runCalculators(
  body: CalculatorRunRequest,
  signal?: AbortSignal,
): Promise<CalculatorRunResult> {
  const raw = await request('/calculators/run', z.unknown(), { method: 'POST', body, signal });
  return normalizeCalculatorResponse(raw);
}

/* ---------------------------------------------------------------------- */
/* Scenarios                                                               */
/* ---------------------------------------------------------------------- */

export function createScenario(body: ScenarioCreate, signal?: AbortSignal): Promise<ScenarioDto> {
  return request('/scenarios', scenarioDtoSchema, { method: 'POST', body, signal });
}

export function getScenario(id: string, signal?: AbortSignal): Promise<ScenarioDto> {
  return request(`/scenarios/${encodeURIComponent(id)}`, scenarioDtoSchema, { signal });
}

export type ScenarioUpdate = z.input<typeof scenarioUpdateSchema>;

export function updateScenario(
  id: string,
  body: ScenarioUpdate,
  signal?: AbortSignal,
): Promise<ScenarioDto> {
  return request(`/scenarios/${encodeURIComponent(id)}`, scenarioDtoSchema, {
    method: 'PATCH',
    body,
    signal,
  });
}

export function deleteScenario(id: string, signal?: AbortSignal): Promise<void> {
  return request(
    `/scenarios/${encodeURIComponent(id)}`,
    z.unknown().transform(() => undefined),
    {
      method: 'DELETE',
      signal,
    },
  );
}

export function claimScenario(id: string, signal?: AbortSignal): Promise<ScenarioDto> {
  return request(`/scenarios/${encodeURIComponent(id)}/claim`, scenarioDtoSchema, {
    method: 'POST',
    body: {},
    signal,
  });
}

export function shareScenario(id: string, signal?: AbortSignal): Promise<ScenarioDto> {
  return request(`/scenarios/${encodeURIComponent(id)}/share`, scenarioDtoSchema, {
    method: 'POST',
    body: {},
    signal,
  });
}

export function getSharedScenario(token: string, signal?: AbortSignal): Promise<ScenarioDto> {
  return request(`/scenarios/shared/${encodeURIComponent(token)}`, scenarioDtoSchema, { signal });
}

export interface VerificationRequestInput {
  contactName: string;
  email: string;
  message: string;
  marketIds?: string[];
}

const verificationResponseSchema = z.unknown().transform((value) => {
  const parsed = scenarioDtoSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
});

/** Requests local verification; returns the updated scenario when the API sends one back. */
export function requestVerification(
  id: string,
  body: VerificationRequestInput,
  signal?: AbortSignal,
): Promise<ScenarioDto | null> {
  return request(
    `/scenarios/${encodeURIComponent(id)}/request-verification`,
    verificationResponseSchema,
    {
      method: 'POST',
      body,
      signal,
    },
  );
}

const looseRecord = z.record(z.string(), z.unknown());

export interface SnapshotResult {
  snapshotId: string | null;
  policyVersion: number | null;
  generatedAt: string | null;
  raw: unknown;
}

const pickString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
};
const pickNumber = (record: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};

export async function snapshotScenario(id: string, signal?: AbortSignal): Promise<SnapshotResult> {
  const raw = await request(`/scenarios/${encodeURIComponent(id)}/snapshot`, z.unknown(), {
    method: 'POST',
    body: {},
    signal,
  });
  const record = looseRecord.safeParse(raw);
  const r = record.success ? record.data : {};
  const nested = looseRecord.safeParse(r.snapshot);
  const n = nested.success ? nested.data : {};
  return {
    snapshotId: pickString(r, ['snapshotId', 'id']) ?? pickString(n, ['id', 'snapshotId']),
    policyVersion: pickNumber(r, ['policyVersion']) ?? pickNumber(n, ['policyVersion']),
    generatedAt:
      pickString(r, ['generatedAt', 'createdAt']) ?? pickString(n, ['generatedAt', 'createdAt']),
    raw,
  };
}

export interface ScenarioReportJson {
  kind: 'json';
  title: string | null;
  generatedAt: string | null;
  policyVersion: number | null;
  snapshotId: string | null;
  disclaimers: string[];
  comparison: ComparisonResponse | null;
  raw: Record<string, unknown>;
}

export interface ScenarioReportDocument {
  kind: 'document';
  url: string;
  contentType: string;
}

export type ScenarioReport = ScenarioReportJson | ScenarioReportDocument;

/** GET the dated report; JSON is normalised, any other document is linked for download/print. */
export async function getScenarioReport(id: string, signal?: AbortSignal): Promise<ScenarioReport> {
  const path = `/scenarios/${encodeURIComponent(id)}/report`;
  const res = await send(path, { signal });
  if (!res.ok) throw await readError(res);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    return { kind: 'document', url: `${API_BASE}${path}`, contentType };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ExplorerApiError('contract', 'The report response was not valid JSON.', {
      retryable: false,
    });
  }
  const record = looseRecord.safeParse(json);
  const r = record.success ? record.data : {};
  const report = looseRecord.safeParse(r.report).success
    ? (r.report as Record<string, unknown>)
    : r;
  const disclaimers = Array.isArray(report.disclaimers)
    ? report.disclaimers.filter((d): d is string => typeof d === 'string')
    : typeof report.disclaimer === 'string'
      ? [report.disclaimer]
      : [];
  const comparison = comparisonResponseSchema.safeParse(report.comparison);
  return {
    kind: 'json',
    title: pickString(report, ['title', 'reportTitle', 'name']),
    generatedAt: pickString(report, ['generatedAt', 'createdAt']),
    policyVersion: pickNumber(report, ['policyVersion']),
    snapshotId: pickString(report, ['snapshotId']),
    disclaimers,
    comparison: comparison.success ? comparison.data : null,
    raw: report,
  };
}
