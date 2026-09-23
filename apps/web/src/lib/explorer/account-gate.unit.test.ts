import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ACCESS,
  buildResumeHref,
  buildSignInHref,
  decideScenarioAction,
  type GatedAction,
} from './account-gate';
import { loadDraft, memoryStorage, saveDraft } from './draft-storage';
import {
  RESUME_INTENTS,
  isResumeIntent,
  resumeIntentFromNext,
  resumeMessage,
} from './resume-intents';
import { DEFAULT_ASSUMPTIONS } from './scenario-form';
import {
  DEFAULT_FILTERS,
  explorerParsers,
  filtersFromParams,
  paramsFromFilters,
  type ExplorerParams,
} from './url-state';

const ACTIONS: GatedAction[] = ['save', 'share', 'verify', 'service', 'report'];

describe('decideScenarioAction', () => {
  it('lets signed-in users do everything', () => {
    for (const action of ACTIONS) {
      expect(
        decideScenarioAction(action, { signedIn: true, anonymousSavesAllowed: false }),
      ).toEqual({ kind: 'proceed' });
    }
  });

  it('sends anonymous visitors to sign-in for every gated action when the flag is off', () => {
    for (const action of ACTIONS) {
      expect(decideScenarioAction(action, ANONYMOUS_ACCESS)).toEqual({ kind: 'sign_in', action });
    }
  });

  it('allows anonymous saves, verification, services and reports when administrators enable the flag', () => {
    const access = { signedIn: false, anonymousSavesAllowed: true };
    for (const action of ['save', 'verify', 'service', 'report'] as const) {
      expect(decideScenarioAction(action, access)).toEqual({ kind: 'proceed' });
    }
    // Private sharing always needs an account (the server refuses anonymous share links).
    expect(decideScenarioAction('share', access)).toEqual({ kind: 'sign_in', action: 'share' });
  });
});

describe('resume URL round-trip', () => {
  const params: Partial<ExplorerParams> = {
    ...paramsFromFilters({
      ...DEFAULT_FILTERS,
      objective: 'commercial',
      totalBudgetNaira: 120_000_000,
      preferredZones: ['SW', 'NC'],
    }),
    q: '',
    compare: ['ng-lagos', 'ng-ikeja', 'ng-abuja', 'ng-ibadan'],
    view: 'list',
    mode: 'assumption',
    priorities: { affordability: 0.5 },
    market: 'ng-lagos',
  };

  it('keeps every explorer param and adds the action, then wraps it as a same-origin next', () => {
    const resume = buildResumeHref(params, 'save');
    expect(resume.startsWith('/explore?')).toBe(true);
    const query = new URLSearchParams(resume.slice(resume.indexOf('?') + 1));
    expect(query.get('resume')).toBe('save');
    expect(query.get('compare')).toBe('ng-lagos,ng-ikeja,ng-abuja,ng-ibadan');
    expect(query.get('objective')).toBe('commercial');
    expect(query.get('budget')).toBe('120000000');
    expect(query.get('zones')).toBe('SW,NC');
    expect(query.get('mode')).toBe('assumption');
    expect(query.get('view')).toBe('list');
    expect(query.get('priorities')).toBe('affordability:0.5');
    expect(query.get('market')).toBe('ng-lagos');

    const signIn = buildSignInHref(resume);
    expect(signIn.startsWith('/sign-in?next=%2Fexplore%3F')).toBe(true);
    const next = new URLSearchParams(signIn.slice(signIn.indexOf('?') + 1)).get('next');
    expect(next).toBe(resume);
    expect(resumeIntentFromNext(next)).toBe('save');
    expect(buildSignInHref(resume, 'sign-up').startsWith('/sign-up?next=')).toBe(true);
  });

  it('restores the same filters and comparison from the resume URL through the nuqs parsers', () => {
    const resume = buildResumeHref(params, 'report', '/');
    expect(resume.startsWith('/?')).toBe(true);
    const query = new URLSearchParams(resume.slice(resume.indexOf('?') + 1));
    const parsed = Object.fromEntries(
      Object.entries(explorerParsers).map(([key, parser]) => {
        const raw = query.get(key);
        const value = raw === null ? null : parser.parse(raw);
        return [key, value ?? ('defaultValue' in parser ? parser.defaultValue : null)];
      }),
    ) as ExplorerParams;
    expect(parsed.resume).toBe('report');
    expect(parsed.compare).toEqual(['ng-lagos', 'ng-ikeja', 'ng-abuja', 'ng-ibadan']);
    expect(parsed.priorities).toEqual({ affordability: 0.5 });
    expect(filtersFromParams(parsed)).toEqual({
      ...DEFAULT_FILTERS,
      objective: 'commercial',
      totalBudgetNaira: 120_000_000,
      preferredZones: ['SW', 'NC'],
    });
    expect(resumeIntentFromNext(resume)).toBe('report');
  });

  it('never trusts foreign or malformed next paths', () => {
    expect(resumeIntentFromNext(null)).toBeNull();
    expect(resumeIntentFromNext('/portal')).toBeNull();
    expect(resumeIntentFromNext('//evil.example/explore?resume=save')).toBeNull();
    expect(resumeIntentFromNext('https://evil.example/explore?resume=save')).toBeNull();
    expect(resumeIntentFromNext('/admin?resume=save')).toBeNull();
    expect(resumeIntentFromNext('/explore?resume=drop-table')).toBeNull();
    expect(isResumeIntent('save')).toBe(true);
    expect(isResumeIntent('bogus')).toBe(false);
    expect(explorerParsers.resume.parse('bogus')).toBeNull();
    for (const intent of RESUME_INTENTS) expect(resumeMessage(intent)).toContain('Sign in to');
  });
});

describe('draft round-trip across the sign-in redirect', () => {
  it('keeps assumptions, name, priorities, mode and compared markets that the URL does not carry', () => {
    const storage = memoryStorage();
    const assumptions = {
      ...DEFAULT_ASSUMPTIONS,
      base: { ...DEFAULT_ASSUMPTIONS.base, landCostNaira: 25_000_000, grossFloorAreaM2: 320 },
    };
    saveDraft(
      {
        name: 'Lekki duplex plan',
        assumptions,
        priorities: { net_rental_economics: 0.75 },
        mode: 'assumption',
        scenarioId: null,
        compare: ['ng-lagos', 'ng-ikeja'],
      },
      storage,
    );
    const restored = loadDraft(storage);
    expect(restored?.name).toBe('Lekki duplex plan');
    expect(restored?.assumptions.base.landCostNaira).toBe(25_000_000);
    expect(restored?.assumptions.base.grossFloorAreaM2).toBe(320);
    expect(restored?.priorities).toEqual({ net_rental_economics: 0.75 });
    expect(restored?.mode).toBe('assumption');
    expect(restored?.compare).toEqual(['ng-lagos', 'ng-ikeja']);
  });
});
