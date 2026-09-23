import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_ITEM_KINDS,
  ENGAGEMENT_ITEM_KIND_RULES,
  FALLBACK_SECTIONS,
  availableItemTransitions,
  bodyFromSections,
  checkReportContent,
  customerMayAttach,
  customerMayRespond,
  evaluateItemTransition,
  findGuaranteeWording,
  highestSeverity,
  missingRequiredSections,
  sectionsFromFindings,
  statusAfterCustomerInput,
  summarizeItems,
  validateItemFields,
} from './index';

describe('engagement item kind rules', () => {
  it('defines a rule for every kind', () => {
    for (const kind of ENGAGEMENT_ITEM_KINDS) expect(ENGAGEMENT_ITEM_KIND_RULES[kind]).toBeTruthy();
  });

  it('requires a severity for red flags and site findings only', () => {
    for (const kind of ENGAGEMENT_ITEM_KINDS) {
      const problems = validateItemFields({
        kind,
        title: 'x',
        severity: null,
        visibility: 'customer',
      });
      const needs = kind === 'red_flag' || kind === 'site_finding';
      expect(problems.some((p) => p.path === 'severity')).toBe(needs);
    }
    expect(
      validateItemFields({ kind: 'red_flag', title: 'x', severity: 'high', visibility: 'all' }),
    ).toEqual([]);
  });

  it('rejects an empty title', () => {
    expect(
      validateItemFields({ kind: 'query', title: '  ', severity: null, visibility: 'customer' }),
    ).toEqual([{ path: 'title', message: 'required' }]);
  });
});

describe('engagement item transitions', () => {
  const base = { kind: 'query' as const, evidenceCount: 0, reference: null };

  it('lets managers and assignees work an item and satisfy it', () => {
    expect(
      evaluateItemTransition({ ...base, from: 'open', to: 'in_progress', actor: 'assignee' }),
    ).toEqual({ ok: true, resolves: false, reopens: false });
    expect(
      evaluateItemTransition({ ...base, from: 'in_progress', to: 'satisfied', actor: 'manager' }),
    ).toEqual({ ok: true, resolves: true, reopens: false });
  });

  it('requires a reason for failed, waived, cancelled and reopening', () => {
    for (const to of ['failed', 'waived', 'cancelled'] as const) {
      const r = evaluateItemTransition({ ...base, from: 'open', to, actor: 'manager' });
      expect(r).toMatchObject({ ok: false, code: 'reason_required' });
      expect(
        evaluateItemTransition({ ...base, from: 'open', to, actor: 'manager', reason: 'why' }),
      ).toMatchObject({ ok: true, resolves: true });
    }
    expect(
      evaluateItemTransition({ ...base, from: 'satisfied', to: 'in_progress', actor: 'manager' }),
    ).toMatchObject({ ok: false, code: 'reason_required' });
    expect(
      evaluateItemTransition({
        ...base,
        from: 'satisfied',
        to: 'in_progress',
        actor: 'assignee',
        reason: 'new document arrived',
      }),
    ).toEqual({ ok: true, resolves: false, reopens: true });
  });

  it('keeps waiving and cancelling with staff who manage the request', () => {
    expect(
      evaluateItemTransition({
        ...base,
        from: 'open',
        to: 'waived',
        actor: 'assignee',
        reason: 'not needed',
      }),
    ).toMatchObject({ ok: false, code: 'actor_not_allowed' });
    expect(
      evaluateItemTransition({ ...base, from: 'open', to: 'in_progress', actor: 'customer' }),
    ).toMatchObject({ ok: false, code: 'actor_not_allowed' });
  });

  it('treats cancelled as terminal', () => {
    expect(
      evaluateItemTransition({
        ...base,
        from: 'cancelled',
        to: 'open',
        actor: 'manager',
        reason: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'terminal_state' });
    expect(availableItemTransitions('cancelled', 'manager')).toEqual([]);
  });

  it('refuses transitions that are not in the table', () => {
    expect(
      evaluateItemTransition({ ...base, from: 'satisfied', to: 'waived', actor: 'manager', reason: 'x' }),
    ).toMatchObject({ ok: false, code: 'invalid_transition' });
  });

  it('needs a reference before a survey reference is satisfied', () => {
    const input = {
      kind: 'survey_reference' as const,
      from: 'open' as const,
      to: 'satisfied' as const,
      actor: 'assignee' as const,
      evidenceCount: 0,
    };
    expect(evaluateItemTransition({ ...input, reference: null })).toMatchObject({
      ok: false,
      code: 'reference_required',
    });
    expect(evaluateItemTransition({ ...input, reference: 'LA/1234/2019' })).toMatchObject({
      ok: true,
    });
  });

  it('needs evidence before a document check or handover document is satisfied', () => {
    for (const kind of ['document_check', 'handover_document'] as const) {
      const input = { kind, from: 'in_progress' as const, to: 'satisfied' as const };
      expect(
        evaluateItemTransition({ ...input, actor: 'manager', evidenceCount: 0 }),
      ).toMatchObject({ ok: false, code: 'evidence_required' });
      expect(
        evaluateItemTransition({ ...input, actor: 'manager', evidenceCount: 1 }),
      ).toMatchObject({ ok: true });
    }
  });

  it('lists only the transitions an actor may take', () => {
    const assignee = availableItemTransitions('open', 'assignee').map((t) => t.to);
    expect(assignee).toEqual(['in_progress', 'satisfied', 'failed']);
    const manager = availableItemTransitions('open', 'manager').map((t) => t.to);
    expect(manager).toEqual(['in_progress', 'satisfied', 'failed', 'waived', 'cancelled']);
    expect(availableItemTransitions('open', 'customer')).toEqual([]);
  });
});

describe('customer input on items', () => {
  it('lets customers answer customer-visible open queries only', () => {
    expect(customerMayRespond({ kind: 'query', visibility: 'customer', status: 'open' })).toEqual({
      ok: true,
    });
    expect(customerMayRespond({ kind: 'query', visibility: 'internal', status: 'open' }).ok).toBe(
      false,
    );
    expect(customerMayRespond({ kind: 'query', visibility: 'all', status: 'satisfied' }).ok).toBe(
      false,
    );
    expect(customerMayRespond({ kind: 'red_flag', visibility: 'all', status: 'open' }).ok).toBe(
      false,
    );
  });

  it('lets customers upload against document checks they can see', () => {
    expect(
      customerMayAttach({ kind: 'document_check', visibility: 'customer', status: 'in_progress' }),
    ).toEqual({ ok: true });
    expect(
      customerMayAttach({ kind: 'document_check', visibility: 'partner', status: 'open' }).ok,
    ).toBe(false);
    expect(customerMayAttach({ kind: 'site_finding', visibility: 'all', status: 'open' }).ok).toBe(
      false,
    );
  });

  it('moves an open item to in progress after customer input', () => {
    expect(statusAfterCustomerInput('open')).toBe('in_progress');
    expect(statusAfterCustomerInput('in_progress')).toBe('in_progress');
  });
});

describe('item summaries', () => {
  it('counts open red flags, customer queries and document requests', () => {
    const s = summarizeItems([
      { kind: 'red_flag', status: 'open', severity: 'high', visibility: 'customer' },
      { kind: 'red_flag', status: 'in_progress', severity: 'critical', visibility: 'internal' },
      { kind: 'red_flag', status: 'satisfied', severity: 'critical', visibility: 'all' },
      { kind: 'query', status: 'open', severity: null, visibility: 'customer' },
      { kind: 'query', status: 'open', severity: null, visibility: 'internal' },
      { kind: 'document_check', status: 'open', severity: null, visibility: 'all' },
      { kind: 'document_check', status: 'cancelled', severity: null, visibility: 'all' },
    ]);
    expect(s.total).toBe(6);
    expect(s.open).toBe(5);
    expect(s.redFlags).toEqual({ open: 2, total: 3, highestOpenSeverity: 'critical' });
    expect(s.openCustomerQueries).toBe(1);
    expect(s.openDocumentRequests).toBe(1);
    expect(s.byKind.document_check).toEqual({ total: 1, open: 1 });
  });

  it('orders severities', () => {
    expect(highestSeverity(['low', null, 'medium'])).toBe('medium');
    expect(highestSeverity([])).toBeNull();
  });
});

describe('service-request report content', () => {
  const sections = FALLBACK_SECTIONS.diligence_memo;

  it('builds a heading-only skeleton from template sections', () => {
    const body = bodyFromSections(sections);
    expect(body).toContain('## Summary of findings');
    expect(body).not.toMatch(/guarantee/i);
    // A skeleton is not a finished report: every required section is still empty.
    expect(missingRequiredSections(body, sections).map((s) => s.key)).toEqual([
      'summary',
      'documents',
      'red_flags',
      'recommendation',
    ]);
  });

  it('recognises filled sections regardless of heading case and comments', () => {
    const body = [
      '## summary of FINDINGS',
      'Title chain reviewed.',
      '## Documents reviewed',
      '<!-- to do -->',
      '## Red flags and open queries',
      'One open query.',
      '## Recommendation',
      'Proceed after the query is answered.',
    ].join('\n');
    expect(missingRequiredSections(body, sections).map((s) => s.key)).toEqual(['documents']);
  });

  it('requires scope and limitations, required sections and no guarantee wording', () => {
    const problems = checkReportContent({
      kind: 'diligence_memo',
      bodyMarkdown: '## Summary of findings\nWe guarantee the title is clean.',
      scopeLimitations: null,
      sections,
    });
    const codes = problems.map((p) => p.code);
    expect(codes).toContain('scope_limitations_required');
    expect(codes).toContain('section_missing');
    expect(codes).toContain('guarantee_wording');
  });

  it('accepts disclaimers that deny a guarantee', () => {
    expect(
      findGuaranteeWording(
        'This memorandum is not a guarantee of title. SimplexD does not guarantee outcomes.',
      ),
    ).toEqual([]);
    expect(findGuaranteeWording('The title is guaranteed by our review')).toHaveLength(1);
  });

  it('does not apply guarantee checks to inspection reports but does require limitations', () => {
    const problems = checkReportContent({
      kind: 'virtual_inspection',
      bodyMarkdown: '## Summary\nWe certify the roof.',
      scopeLimitations: '  ',
      sections: [],
    });
    expect(problems.map((p) => p.code)).toEqual(['scope_limitations_required']);
  });

  it('reads template sections from stored findings defensively', () => {
    expect(sectionsFromFindings(null)).toEqual([]);
    expect(sectionsFromFindings({ template: { sections: 'nope' } })).toEqual([]);
    expect(
      sectionsFromFindings({
        template: { sections: [{ key: 'a', heading: 'A', required: true }, { bad: 1 }] },
      }),
    ).toEqual([{ key: 'a', heading: 'A', required: true }]);
  });
});
