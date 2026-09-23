'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@simplexd/ui';
import type {
  ExplorerFilters,
  Objective,
  Priorities,
  ScenarioAssumptions,
  ScenarioDto,
} from '@simplexd/contracts';
import {
  buildScenarioCreate,
  claimScenario,
  createScenario,
  describeError,
  getScenario,
  getScenarioReport,
  getSharedScenario,
  requestVerification as requestVerificationApi,
  saveLastScenarioId,
  shareScenario,
  snapshotScenario,
  stableKey,
  updateScenario,
  type ExplorerMode,
  type ScenarioReport,
  type SnapshotResult,
  type VerificationRequestInput,
} from '@/lib/explorer';

/**
 * Saved-scenario lifecycle: load by id (or shared token), save/update, share,
 * claim, request local verification and generate the dated report. The
 * scenario id lives in the URL so a reload preserves it; the last saved id is
 * also kept in localStorage for anonymous continuity.
 */

export type ScenarioBusy = 'saving' | 'sharing' | 'claiming' | 'verifying' | 'reporting' | null;

export interface GeneratedReport {
  scenario: ScenarioDto;
  snapshot: SnapshotResult;
  report: ScenarioReport;
}

export interface ScenarioDeps {
  scenarioId: string | null;
  sharedToken: string | null;
  /** Null until the market list has loaded (needed to map ids to slugs on hydration). */
  marketsLoaded: boolean;
  objective: Objective;
  filters: ExplorerFilters;
  mode: ExplorerMode;
  priorities: Priorities;
  assumptions: ScenarioAssumptions;
  name: string;
  compareIds: string[];
  hasUrlFilters: boolean;
  applyHydration: (dto: ScenarioDto, options: { hydrateFilters: boolean }) => void;
  setScenarioParam: (id: string | null) => void;
}

export interface ScenarioState {
  id: string | null;
  dto: ScenarioDto | null;
  /** A shared (read-only) scenario opened through a share link. */
  shared: ScenarioDto | null;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  dirty: boolean;
  busy: ScenarioBusy;
  lastSavedAt: string | null;
  save: (name?: string) => Promise<ScenarioDto | null>;
  share: () => Promise<string | null>;
  claim: () => Promise<ScenarioDto | null>;
  requestVerification: (input: VerificationRequestInput) => Promise<boolean>;
  generateReport: () => Promise<GeneratedReport | null>;
}

const payloadKey = (input: {
  name: string;
  objective: Objective;
  mode: ExplorerMode;
  filters: ExplorerFilters;
  assumptions: ScenarioAssumptions;
  priorities: Priorities;
  marketIds: string[];
}): string =>
  stableKey({
    objective: input.objective,
    mode: input.mode,
    filters: input.filters,
    assumptions: input.assumptions,
    priorities: input.priorities,
    marketIds: [...input.marketIds].sort(),
  });

export function useScenario(deps: ScenarioDeps): ScenarioState {
  const {
    scenarioId,
    sharedToken,
    marketsLoaded,
    objective,
    filters,
    mode,
    priorities,
    assumptions,
    name,
    compareIds,
    hasUrlFilters,
    applyHydration,
    setScenarioParam,
  } = deps;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState<ScenarioBusy>(null);

  const scenarioQuery = useQuery({
    queryKey: ['explorer', 'scenario', scenarioId],
    queryFn: ({ signal }) => getScenario(scenarioId as string, signal),
    enabled: scenarioId !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const sharedQuery = useQuery({
    queryKey: ['explorer', 'scenario-shared', sharedToken],
    queryFn: ({ signal }) => getSharedScenario(sharedToken as string, signal),
    enabled: sharedToken !== null && scenarioId === null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const dto = scenarioId !== null ? (scenarioQuery.data ?? null) : null;
  const shared = scenarioId === null && sharedToken !== null ? (sharedQuery.data ?? null) : null;

  // Hydrate the explorer once per loaded scenario id (never after our own saves).
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    const loaded = dto ?? shared;
    if (!loaded || !marketsLoaded) return;
    if (hydratedRef.current === loaded.id) return;
    hydratedRef.current = loaded.id;
    applyHydration(loaded, { hydrateFilters: !hasUrlFilters });
  }, [dto, shared, marketsLoaded, hasUrlFilters, applyHydration]);

  const currentPayload = useMemo(
    () =>
      buildScenarioCreate({
        name,
        objective,
        mode,
        filters,
        assumptions,
        priorities,
        marketIds: compareIds,
      }),
    [name, objective, mode, filters, assumptions, priorities, compareIds],
  );

  const dirty = useMemo(() => {
    if (!dto) return true;
    return (
      payloadKey(currentPayload) !==
      payloadKey({
        name: dto.name,
        objective: dto.objective,
        mode: dto.mode,
        filters: dto.filters,
        assumptions: dto.assumptions,
        priorities: dto.priorities,
        marketIds: dto.marketIds,
      })
    );
  }, [currentPayload, dto]);

  const report = useCallback(
    (title: string, error: unknown) => {
      const described = describeError(error);
      toast({
        title,
        description: described.correlationId
          ? `${described.message} (ref ${described.correlationId})`
          : described.message,
        tone: 'danger',
      });
    },
    [toast],
  );

  const remember = useCallback(
    (saved: ScenarioDto) => {
      hydratedRef.current = saved.id;
      queryClient.setQueryData(['explorer', 'scenario', saved.id], saved);
      saveLastScenarioId(saved.id);
    },
    [queryClient],
  );

  const save = useCallback(
    async (nameOverride?: string): Promise<ScenarioDto | null> => {
      setBusy('saving');
      try {
        const payload = buildScenarioCreate({
          name: nameOverride ?? name,
          objective,
          mode,
          filters,
          assumptions,
          priorities,
          marketIds: compareIds,
        });
        let saved: ScenarioDto;
        if (dto) {
          saved = await updateScenario(dto.id, { ...payload, expectedUpdatedAt: dto.updatedAt });
        } else {
          saved = await createScenario(payload);
          setScenarioParam(saved.id);
        }
        remember(saved);
        toast({ title: 'Scenario saved', description: saved.name, tone: 'success' });
        return saved;
      } catch (error) {
        const described = describeError(error);
        if (described.code === 'version_conflict' && dto) {
          toast({
            title: 'This scenario changed elsewhere',
            description: 'The latest version has been reloaded; review it and save again.',
            tone: 'danger',
          });
          void queryClient.invalidateQueries({ queryKey: ['explorer', 'scenario', dto.id] });
        } else {
          report('Could not save the scenario', error);
        }
        return null;
      } finally {
        setBusy(null);
      }
    },
    [
      name,
      objective,
      mode,
      filters,
      assumptions,
      priorities,
      compareIds,
      dto,
      remember,
      setScenarioParam,
      toast,
      queryClient,
      report,
    ],
  );

  const ensureSaved = useCallback(async (): Promise<ScenarioDto | null> => {
    if (dto && !dirty) return dto;
    return save();
  }, [dto, dirty, save]);

  const share = useCallback(async (): Promise<string | null> => {
    setBusy('sharing');
    try {
      const saved = await ensureSaved();
      if (!saved) return null;
      const updated = await shareScenario(saved.id);
      remember(updated);
      if (!updated.shareToken) {
        toast({ title: 'Sharing is not available for this scenario yet', tone: 'info' });
        return null;
      }
      const origin = typeof window === 'undefined' ? '' : window.location.origin;
      return `${origin}/explore?shared=${encodeURIComponent(updated.shareToken)}`;
    } catch (error) {
      report('Could not create a share link', error);
      return null;
    } finally {
      setBusy(null);
    }
  }, [ensureSaved, remember, toast, report]);

  const claim = useCallback(async (): Promise<ScenarioDto | null> => {
    if (!dto) return null;
    setBusy('claiming');
    try {
      const updated = await claimScenario(dto.id);
      remember(updated);
      toast({ title: 'Scenario added to your account', tone: 'success' });
      return updated;
    } catch (error) {
      report('Could not claim the scenario', error);
      return null;
    } finally {
      setBusy(null);
    }
  }, [dto, remember, toast, report]);

  const requestVerification = useCallback(
    async (input: VerificationRequestInput): Promise<boolean> => {
      setBusy('verifying');
      try {
        const saved = await ensureSaved();
        if (!saved) return false;
        const updated = await requestVerificationApi(saved.id, { ...input, marketIds: compareIds });
        if (updated) remember(updated);
        else void queryClient.invalidateQueries({ queryKey: ['explorer', 'scenario', saved.id] });
        toast({
          title: 'Verification request sent',
          description: 'A SimplexD researcher will review the local evidence and reply by email.',
          tone: 'success',
        });
        return true;
      } catch (error) {
        report('Could not send the verification request', error);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [ensureSaved, compareIds, remember, queryClient, toast, report],
  );

  const generateReport = useCallback(async (): Promise<GeneratedReport | null> => {
    setBusy('reporting');
    try {
      const saved = await ensureSaved();
      if (!saved) return null;
      const snapshot = await snapshotScenario(saved.id);
      const generated = await getScenarioReport(saved.id);
      return { scenario: saved, snapshot, report: generated };
    } catch (error) {
      report('Could not generate the comparison report', error);
      return null;
    } finally {
      setBusy(null);
    }
  }, [ensureSaved, report]);

  const refetch = useCallback(() => {
    if (scenarioId !== null) void scenarioQuery.refetch();
    else if (sharedToken !== null) void sharedQuery.refetch();
  }, [scenarioId, sharedToken, scenarioQuery, sharedQuery]);

  return {
    id: dto?.id ?? scenarioId,
    dto,
    shared,
    isLoading:
      (scenarioId !== null && scenarioQuery.isLoading) ||
      (sharedToken !== null && scenarioId === null && sharedQuery.isLoading),
    error: scenarioId !== null ? scenarioQuery.error : sharedQuery.error,
    refetch,
    dirty,
    busy,
    lastSavedAt: dto?.updatedAt ?? null,
    save,
    share,
    claim,
    requestVerification,
    generateReport,
  };
}
