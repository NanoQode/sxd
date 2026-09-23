import { describe, expect, it } from 'vitest';
import { timelineMessages, wallClockToIso } from '@/app/(admin)/admin/tenders/_lib/timeline';
import { rowsToCsv } from './csv';
import { lineProblem, percentToBps } from './invoice-lines';
import { FORM_TRANSFORMS, buildBody, fillTemplate, setPath, splitList } from './form-body';
import { koboToNairaInput, lineAmountKobo, parseNairaToKobo, sumKobo } from './money';
import { normalizeQuery, parseViews } from './saved-views';
import { summarizeSla } from './sla';

describe('form bodies built declaratively (server pages cannot pass functions)', () => {
  it('omits empty values by default, sends null when asked, splits lists and nests dotted keys', () => {
    const body = buildBody(
      [
        { name: 'title' },
        { name: 'description', emptyAs: 'null' },
        { name: 'counterparty' },
        { name: 'drawingFileIds', list: true },
        { name: 'summary', bodyKey: 'initialRevision.summary' },
        { name: 'ui', omitFromBody: true },
      ],
      {
        title: 'Roof',
        description: undefined,
        counterparty: '',
        drawingFileIds: 'a, b,,c',
        summary: 'ok',
        ui: 'x',
      },
      { expectedVersion: 3, 'initialRevision.attachmentFileIds': [] },
    );
    expect(body).toEqual({
      title: 'Roof',
      description: null,
      drawingFileIds: ['a', 'b', 'c'],
      initialRevision: { summary: 'ok', attachmentFileIds: [] },
      expectedVersion: 3,
    });
  });

  it('setPath creates intermediate objects and splitList accepts commas and new lines', () => {
    const t: Record<string, unknown> = {};
    setPath(t, 'a.b.c', 1);
    expect(t).toEqual({ a: { b: { c: 1 } } });
    expect(splitList('x\ny, z')).toEqual(['x', 'y', 'z']);
  });

  it('fills redirect templates from the API result and encodes values', () => {
    expect(fillTemplate('/admin/reports/{id}', { id: 'abc' })).toBe('/admin/reports/abc');
    expect(fillTemplate('/x/{id}', null)).toBe('/x/');
    expect(fillTemplate('/x/{id}', { id: 'a/b' })).toBe('/x/a%2Fb');
  });

  it('sends a permit statutory target only with both days and a source', () => {
    const base = { jurisdiction: 'Lagos', authority: 'LASPPPA', permitType: 'Building' };
    expect(
      FORM_TRANSFORMS.permitApplication({ ...base, statutoryDays: 90 }, { propertyId: 'p' }),
    ).toMatchObject({ statutoryTarget: null, propertyId: 'p' });
    expect(
      FORM_TRANSFORMS.permitApplication(
        { ...base, statutoryDays: 90, statutorySource: 'Regulation 12' },
        {},
      ),
    ).toMatchObject({
      statutoryTarget: { days: 90, basis: 'business', sourceNote: 'Regulation 12' },
    });
  });
});

describe('money helpers (integer kobo, no floating point)', () => {
  it('parses naira input including reductions and rejects junk', () => {
    expect(parseNairaToKobo('1,250,000.50')).toBe('125000050');
    expect(parseNairaToKobo('₦ 20')).toBe('2000');
    expect(parseNairaToKobo('-5000')).toBe('-500000');
    expect(parseNairaToKobo('-0')).toBe('0');
    expect(parseNairaToKobo('12.345')).toBeNull();
    expect(parseNairaToKobo('abc')).toBeNull();
  });
  it('formats kobo back for prefilled inputs', () => {
    expect(koboToNairaInput('125000050')).toBe('1250000.50');
    expect(koboToNairaInput('2000')).toBe('20');
    expect(koboToNairaInput('-150')).toBe('-1.50');
    expect(koboToNairaInput(null)).toBe('');
  });
  it('computes line amounts and sums exactly', () => {
    expect(lineAmountKobo('2.5', '100001')).toBe('250003');
    expect(sumKobo(['1', null, '2', 'x', '-1'])).toBe('2');
  });
});

describe('invoice line validation', () => {
  it('converts tax percent to basis points and flags bad lines', () => {
    expect(percentToBps('7.5')).toBe(750);
    expect(percentToBps('')).toBe(0);
    expect(percentToBps('101')).toBeNull();
    expect(
      lineProblem({
        description: '',
        quantity: '1',
        unitNaira: '10',
        taxPercent: '',
        accountCode: '',
      }),
    ).toMatch(/Description/);
    expect(
      lineProblem({
        description: 'Fee',
        quantity: '0',
        unitNaira: '10',
        taxPercent: '',
        accountCode: '',
      }),
    ).toMatch(/Quantity/);
    expect(
      lineProblem({
        description: 'Fee',
        quantity: '1',
        unitNaira: '10',
        taxPercent: '',
        accountCode: '40',
      }),
    ).toMatch(/four digits/);
    expect(
      lineProblem({
        description: 'Fee',
        quantity: '1',
        unitNaira: '10',
        taxPercent: '7.5',
        accountCode: '4000',
      }),
    ).toBeNull();
  });
});

describe('tender timeline messages', () => {
  it('explains out-of-order and missing stages in plain words', () => {
    const zone = 'Africa/Lagos';
    const messages = timelineMessages({
      releaseAt: wallClockToIso('2026-10-01T09:00', zone),
      questionCutoffAt: wallClockToIso('2026-10-20T09:00', zone),
      submissionDeadlineAt: wallClockToIso('2026-10-10T17:00', zone),
    });
    expect(messages).toEqual(['Submission deadline must be after Question cut-off.']);
    expect(timelineMessages({ releaseAt: wallClockToIso('2026-10-01T09:00', zone) })).toContain(
      'Submission deadline is required.',
    );
  });
  it('interprets wall-clock input in the display zone with an explicit offset', () => {
    expect(wallClockToIso('2026-10-01T09:00', 'Africa/Lagos')).toBe('2026-10-01T09:00:00+01:00');
    expect(wallClockToIso('', 'Africa/Lagos')).toBeNull();
  });
});

describe('exports and saved views', () => {
  it('quotes CSV cells and neutralises spreadsheet formulas', () => {
    const csv = rowsToCsv(
      [{ a: '=SUM(A1)', b: 'x,"y"' }],
      [
        { header: 'A', value: (r) => r.a },
        { header: 'B', value: (r) => r.b },
      ],
    );
    expect(csv).toBe('A,B\r\n\'=SUM(A1),"x,""y"""\r\n');
  });
  it('normalises saved view queries (no paging, stable order) and ignores corrupt storage', () => {
    expect(normalizeQuery('page=3&status=draft&cursor=abc&a=1')).toBe('a=1&status=draft');
    expect(parseViews('not json')).toEqual([]);
    expect(
      parseViews(
        JSON.stringify([{ name: 'Overdue', query: 'overdue=1', savedAt: 'x' }, { nope: true }]),
      ),
    ).toHaveLength(1);
  });
});

describe('SLA classification', () => {
  it('stops the clock for paused and finished work and flags overdue', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    expect(summarizeSla('2026-09-23T10:00:00Z', 'triage', now).state).toBe('overdue');
    expect(summarizeSla('2026-09-23T15:00:00Z', 'triage', now).state).toBe('due_soon');
    expect(summarizeSla('2026-09-23T10:00:00Z', 'completed', now).state).toBe('stopped');
    expect(summarizeSla(null, 'triage', now).state).toBe('none');
  });
});
