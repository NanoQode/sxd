'use client';

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useQueryStates, type Nullable } from 'nuqs';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '@simplexd/ui';
import type {
  ExplorerFilters,
  MarketGeoJson,
  MarketListResponse,
  MarketSummaryDto,
  Priorities,
  RankedMarketDto,
  RecommendationRequest,
  RecommendationResponse,
  ScenarioAssumptions,
  ScenarioDto,
} from '@simplexd/contracts';
import {
  ANONYMOUS_ACCESS,
  DEFAULT_ASSUMPTIONS,
  FILTER_PARAM_KEYS,
  applyClientFilters,
  applyQuery,
  assumptionsAreUsable,
  buildCalculatorRequest,
  buildExploreHref,
  buildResumeHref,
  buildRows,
  buildSignInHref,
  decideScenarioAction,
  explorerParsers,
  filterGeoJson,
  filtersFromParams,
  geoJsonFromMarkets,
  getMarkets,
  getMarketsGeoJson,
  getStates,
  hasNonDefaultFilters,
  loadDraft,
  loadLastScenarioId,
  paramsFromFilters,
  postRecommendations,
  rankedIndex,
  runCalculators,
  saveDraft,
  toggleCompare as toggleCompareList,
  type AccountAccess,
  type CalculatorRunResult,
  type ExplorerMode,
  type ExplorerParams,
  type ExplorerVariant,
  type ExplorerView,
  type GatedAction,
  type MarketRows,
  type StateOption,
} from '@/lib/explorer';
import { useDebouncedValue } from './use-debounced-value';
import { DESKTOP_QUERY, useMediaQuery } from './use-media-query';
import { useScenario, type ScenarioState } from './use-scenario';

function useExplorerParams() {
  return useQueryStates(explorerParsers);
}
type SetParams = ReturnType<typeof useExplorerParams>[1];
type ParamsPatch = Partial<Nullable<ExplorerParams>>;

export interface ExplorerContextValue {
  variant: ExplorerVariant;
  isDesktop: boolean;
  params: ExplorerParams;
  setParams: SetParams;
  filters: ExplorerFilters;
  setFilters: (patch: Partial<ExplorerFilters>) => void;
  resetFilters: () => void;
  query: string;
  setQuery: (query: string) => void;
  markets: UseQueryResult<MarketListResponse>;
  geojson: UseQueryResult<MarketGeoJson>;
  states: UseQueryResult<StateOption[]>;
  stateOptions: StateOption[];
  recommendation: UseQueryResult<RecommendationResponse>;
  rankedBySlug: Map<string, RankedMarketDto>;
  rows: MarketRows;
  visibleMarkets: MarketSummaryDto[];
  visibleGeoJson: MarketGeoJson | null;
  totalMarkets: number;
  selectedSlug: string | null;
  selectedMarket: MarketSummaryDto | null;
  select: (slug: string | null) => void;
  compareSlugs: string[];
  compareMarkets: MarketSummaryDto[];
  compareFull: boolean;
  toggleCompare: (slug: string) => void;
  clearCompare: () => void;
  mode: ExplorerMode;
  setMode: (mode: ExplorerMode) => void;
  view: ExplorerView;
  setView: (view: ExplorerView) => void;
  priorities: Priorities;
  setPriorities: (priorities: Priorities) => void;
  assumptions: ScenarioAssumptions;
  setAssumptions: (assumptions: ScenarioAssumptions) => void;
  scenarioName: string;
  setScenarioName: (name: string) => void;
  calculators: UseQueryResult<CalculatorRunResult>;
  calculatorsUsable: boolean;
  scenario: ScenarioState;
  /** Id of the last scenario saved on this device, offered when nothing is open. */
  lastScenarioId: string | null;
  /** Who the server rendered the explorer for and whether anonymous server-side saves are allowed. */
  access: AccountAccess;
  /**
   * Account gate (brief §5). Returns true when the action may proceed. Otherwise the
   * draft is stored, the visitor goes to sign-in with the full explorer URL in
   * `next` and the action in `resume`, and false is returned.
   */
  requireAccount: (action: GatedAction) => boolean;
  /** Action interrupted by sign-in, restored once after the visitor comes back signed in. */
  resumeIntent: GatedAction | null;
  clearResumeIntent: () => void;
  /** Sign-in and sign-up links that bring the visitor back to this explorer state. */
  signInHref: string;
  signUpHref: string;
}

const ExplorerContext = createContext<ExplorerContextValue | null>(null);

export function useExplorer(): ExplorerContextValue {
  const ctx = useContext(ExplorerContext);
  if (!ctx) throw new Error('useExplorer must be used within ExplorerProvider');
  return ctx;
}

const isEmptyPriorities = (p: Priorities): boolean => Object.keys(p).length === 0;

export function ExplorerProvider({
  variant,
  access = ANONYMOUS_ACCESS,
  children,
}: {
  variant: ExplorerVariant;
  access?: AccountAccess;
  children: ReactNode;
}) {
  const [params, setParams] = useExplorerParams();
  const { toast } = useToast();
  const router = useRouter();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const mode = params.mode;
  const view = params.view;
  const priorities = params.priorities;

  const [assumptions, setAssumptionsState] = useState<ScenarioAssumptions>(DEFAULT_ASSUMPTIONS);
  const [scenarioName, setScenarioName] = useState('');
  const [lastScenarioId, setLastScenarioId] = useState<string | null>(null);
  const [resumeIntent, setResumeIntent] = useState<GatedAction | null>(null);

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */

  const markets = useQuery({
    queryKey: ['explorer', 'markets', filters.objective],
    queryFn: ({ signal }) => getMarkets({ objective: filters.objective, limit: 200 }, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const geojson = useQuery({
    queryKey: ['explorer', 'geojson'],
    queryFn: ({ signal }) => getMarketsGeoJson(signal),
    staleTime: 5 * 60_000,
  });

  const states = useQuery({
    queryKey: ['explorer', 'states'],
    queryFn: ({ signal }) => getStates(signal),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const stateOptions = useMemo<StateOption[]>(() => {
    if (states.data) return [...states.data].sort((a, b) => a.name.localeCompare(b.name));
    // Fall back to the states present in the market list.
    const seen = new Map<string, StateOption>();
    for (const market of markets.data?.items ?? []) {
      const existing = seen.get(market.stateId);
      if (existing) existing.marketCount += 1;
      else
        seen.set(market.stateId, {
          id: market.stateId,
          name: market.stateName,
          geopoliticalZone: market.geopoliticalZone,
          isFederalCapital: market.isFederalCapital,
          marketCount: 1,
        });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [states.data, markets.data]);

  const recommendationInput = useMemo<RecommendationRequest>(
    () => ({
      objective: filters.objective,
      mode,
      filters,
      priorities,
      assumptions: mode === 'assumption' ? assumptions : null,
      rank: true,
      budgetCeiling:
        filters.totalBudgetNaira !== null ? { amountNaira: filters.totalBudgetNaira } : null,
    }),
    [filters, mode, priorities, assumptions],
  );
  const debouncedRecommendationInput = useDebouncedValue(recommendationInput, 350);

  const recommendation = useQuery({
    queryKey: ['explorer', 'recommendation', debouncedRecommendationInput],
    queryFn: ({ signal }) => postRecommendations(debouncedRecommendationInput, signal),
    enabled: Boolean(markets.data),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  const rankedBySlug = useMemo(() => rankedIndex(recommendation.data), [recommendation.data]);

  const filteredMarkets = useMemo(() => {
    const items = markets.data?.items ?? [];
    return applyQuery(applyClientFilters(items, filters, { rankedBySlug }), params.q);
  }, [markets.data, filters, rankedBySlug, params.q]);

  const rows = useMemo(
    () => buildRows(filteredMarkets, recommendation.data ?? null),
    [filteredMarkets, recommendation.data],
  );

  const visibleMarkets = useMemo(
    () => [...rows.organic, ...rows.sponsored].map((row) => row.market),
    [rows],
  );

  const visibleGeoJson = useMemo<MarketGeoJson | null>(() => {
    const source = geojson.data ?? (markets.data ? geoJsonFromMarkets(markets.data.items) : null);
    if (!source) return null;
    return filterGeoJson(source, new Set(visibleMarkets.map((m) => m.slug)));
  }, [geojson.data, markets.data, visibleMarkets]);

  /* ------------------------------------------------------------------ */
  /* Selection and comparison                                            */
  /* ------------------------------------------------------------------ */

  const marketBySlug = useMemo(() => {
    const index = new Map<string, MarketSummaryDto>();
    for (const market of markets.data?.items ?? []) index.set(market.slug, market);
    return index;
  }, [markets.data]);

  const selectedSlug = params.market;
  const selectedMarket = selectedSlug ? (marketBySlug.get(selectedSlug) ?? null) : null;

  const select = useCallback(
    (slug: string | null) => {
      void setParams({ market: slug });
    },
    [setParams],
  );

  const compareSlugs = params.compare;
  const compareMarkets = useMemo(
    () =>
      compareSlugs
        .map((slug) => marketBySlug.get(slug))
        .filter((m): m is MarketSummaryDto => m !== undefined),
    [compareSlugs, marketBySlug],
  );

  const toggleCompare = useCallback(
    (slug: string) => {
      const result = toggleCompareList(params.compare, slug);
      if (result.rejected === 'limit') {
        toast({
          title: 'Compare up to four markets',
          description: 'Remove one from the comparison tray to add another.',
          tone: 'info',
        });
        return;
      }
      void setParams({ compare: result.list });
    },
    [params.compare, setParams, toast],
  );

  const clearCompare = useCallback(() => {
    void setParams({ compare: [] });
  }, [setParams]);

  /* ------------------------------------------------------------------ */
  /* Filters, mode, view, priorities                                     */
  /* ------------------------------------------------------------------ */

  const setFilters = useCallback(
    (patch: Partial<ExplorerFilters>) => {
      const { q: _q, ...next } = paramsFromFilters({ ...filters, ...patch });
      void setParams(next);
    },
    [filters, setParams],
  );

  const resetFilters = useCallback(() => {
    const cleared: ParamsPatch = {};
    for (const key of FILTER_PARAM_KEYS) cleared[key] = null;
    void setParams(cleared);
  }, [setParams]);

  const setQuery = useCallback(
    (query: string) => {
      void setParams({ q: query === '' ? null : query });
    },
    [setParams],
  );

  const setMode = useCallback(
    (next: ExplorerMode) => {
      void setParams({ mode: next });
    },
    [setParams],
  );

  const setView = useCallback(
    (next: ExplorerView) => {
      void setParams({ view: next });
    },
    [setParams],
  );

  const setPriorities = useCallback(
    (next: Priorities) => {
      void setParams({ priorities: next });
    },
    [setParams],
  );

  const setAssumptions = useCallback((next: ScenarioAssumptions) => {
    setAssumptionsState(next);
  }, []);

  /* ------------------------------------------------------------------ */
  /* Calculators (assumption mode)                                       */
  /* ------------------------------------------------------------------ */

  const calculatorsUsable = useMemo(() => assumptionsAreUsable(assumptions), [assumptions]);
  const calculatorInput = useMemo(
    () => buildCalculatorRequest(assumptions, filters.objective),
    [assumptions, filters.objective],
  );
  const debouncedCalculatorInput = useDebouncedValue(calculatorInput, 400);

  const calculators = useQuery({
    queryKey: ['explorer', 'calculators', debouncedCalculatorInput],
    queryFn: ({ signal }) => runCalculators(debouncedCalculatorInput, signal),
    enabled: mode === 'assumption' && calculatorsUsable,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  /* ------------------------------------------------------------------ */
  /* Saved scenario                                                      */
  /* ------------------------------------------------------------------ */

  const compareIds = useMemo(() => compareMarkets.map((m) => m.id), [compareMarkets]);
  const hasUrlFilters = useMemo(() => hasNonDefaultFilters(params), [params]);

  const applyHydration = useCallback(
    (dto: ScenarioDto, options: { hydrateFilters: boolean }) => {
      setAssumptionsState(dto.assumptions);
      setScenarioName(dto.name);
      const slugs = dto.marketIds
        .map((id) => [...marketBySlug.values()].find((m) => m.id === id)?.slug)
        .filter((slug): slug is string => typeof slug === 'string');
      if (options.hydrateFilters) {
        const { q: _q, ...filterParams } = paramsFromFilters(dto.filters);
        void setParams({
          ...filterParams,
          mode: dto.mode,
          priorities: dto.priorities,
          compare: slugs,
        });
      } else {
        const patch: ParamsPatch = {};
        if (isEmptyPriorities(params.priorities) && !isEmptyPriorities(dto.priorities)) {
          patch.priorities = dto.priorities;
        }
        if (params.compare.length === 0 && slugs.length > 0) patch.compare = slugs;
        if (Object.keys(patch).length > 0) void setParams(patch);
      }
    },
    [marketBySlug, params.priorities, params.compare, setParams],
  );

  const setScenarioParam = useCallback(
    (id: string | null) => {
      void setParams({ scenario: id, shared: null });
    },
    [setParams],
  );

  const scenario = useScenario({
    scenarioId: params.scenario,
    sharedToken: params.shared,
    marketsLoaded: Boolean(markets.data),
    objective: filters.objective,
    filters,
    mode,
    priorities,
    assumptions,
    name: scenarioName,
    compareIds,
    hasUrlFilters,
    applyHydration,
    setScenarioParam,
  });

  /* ------------------------------------------------------------------ */
  /* Anonymous continuity (localStorage draft)                           */
  /* ------------------------------------------------------------------ */

  const draftRestoredRef = useRef(false);
  const initialParamsRef = useRef(params);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    // localStorage is an external system; restore after mount so server and
    // client render the same first frame.
    const timer = window.setTimeout(() => {
      const initial = initialParamsRef.current;
      setLastScenarioId(loadLastScenarioId());
      if (initial.resume) {
        // The action interrupted by sign-in resumes once, only for a signed-in
        // visitor; the param is consumed so a reload does not repeat it.
        if (access.signedIn) setResumeIntent(initial.resume);
        void setParams({ resume: null });
      }
      if (initial.scenario || initial.shared) return;
      const draft = loadDraft();
      if (!draft) return;
      setAssumptionsState(draft.assumptions);
      setScenarioName(draft.name ?? '');
      if (isEmptyPriorities(initial.priorities) && !isEmptyPriorities(draft.priorities)) {
        void setParams({ priorities: draft.priorities });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [setParams, access.signedIn]);

  const draftInput = useMemo(
    () => ({
      name: scenarioName === '' ? null : scenarioName,
      assumptions,
      priorities,
      mode,
      scenarioId: scenario.id,
      compare: compareSlugs,
    }),
    [assumptions, scenarioName, priorities, mode, scenario.id, compareSlugs],
  );

  useEffect(() => {
    if (!draftRestoredRef.current) return;
    const timer = window.setTimeout(() => {
      saveDraft(draftInput);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draftInput]);

  /* ------------------------------------------------------------------ */
  /* Account gate (brief §5)                                             */
  /* ------------------------------------------------------------------ */

  const explorerPath = variant === 'full' ? '/explore' : '/';
  const signInHref = useMemo(
    () => buildSignInHref(buildExploreHref(params, {}, explorerPath)),
    [params, explorerPath],
  );
  const signUpHref = useMemo(
    () => buildSignInHref(buildExploreHref(params, {}, explorerPath), 'sign-up'),
    [params, explorerPath],
  );

  const requireAccount = useCallback(
    (action: GatedAction): boolean => {
      const decision = decideScenarioAction(action, access);
      if (decision.kind === 'proceed') return true;
      // Flush the draft now: the debounced save may not have run before navigation.
      saveDraft(draftInput);
      router.push(buildSignInHref(buildResumeHref(params, action, explorerPath)));
      return false;
    },
    [access, draftInput, params, explorerPath, router],
  );

  const clearResumeIntent = useCallback(() => setResumeIntent(null), []);

  /* ------------------------------------------------------------------ */

  const value = useMemo<ExplorerContextValue>(
    () => ({
      variant,
      isDesktop,
      params,
      setParams,
      filters,
      setFilters,
      resetFilters,
      query: params.q,
      setQuery,
      markets,
      geojson,
      states,
      stateOptions,
      recommendation,
      rankedBySlug,
      rows,
      visibleMarkets,
      visibleGeoJson,
      totalMarkets: markets.data?.total ?? markets.data?.items.length ?? 0,
      selectedSlug,
      selectedMarket,
      select,
      compareSlugs,
      compareMarkets,
      compareFull: compareSlugs.length >= 4,
      toggleCompare,
      clearCompare,
      mode,
      setMode,
      view,
      setView,
      priorities,
      setPriorities,
      assumptions,
      setAssumptions,
      scenarioName,
      setScenarioName,
      calculators,
      calculatorsUsable,
      scenario,
      lastScenarioId,
      access,
      requireAccount,
      resumeIntent,
      clearResumeIntent,
      signInHref,
      signUpHref,
    }),
    [
      variant,
      isDesktop,
      params,
      setParams,
      filters,
      setFilters,
      resetFilters,
      setQuery,
      markets,
      geojson,
      states,
      stateOptions,
      recommendation,
      rankedBySlug,
      rows,
      visibleMarkets,
      visibleGeoJson,
      selectedSlug,
      selectedMarket,
      select,
      compareSlugs,
      compareMarkets,
      toggleCompare,
      clearCompare,
      mode,
      setMode,
      view,
      setView,
      priorities,
      setPriorities,
      assumptions,
      setAssumptions,
      scenarioName,
      calculators,
      calculatorsUsable,
      scenario,
      lastScenarioId,
      access,
      requireAccount,
      resumeIntent,
      clearResumeIntent,
      signInHref,
      signUpHref,
    ],
  );

  return <ExplorerContext.Provider value={value}>{children}</ExplorerContext.Provider>;
}
