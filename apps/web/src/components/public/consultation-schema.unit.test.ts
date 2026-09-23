import { describe, expect, it } from 'vitest';
import { consultationRequestSchema } from '@simplexd/contracts';
import {
  buildConsultationPayload,
  composeMessage,
  consultationFormSchema,
  fieldForApiPath,
  normalizePhone,
  readPrefill,
  type ConsultationFormValues,
} from './consultation-schema';

const valid: ConsultationFormValues = {
  contactName: 'Ada Obi',
  email: 'Ada@Example.com',
  phone: '+234 801 234 5678',
  countryOfResidence: 'GB',
  timeZone: 'Europe/London',
  goal: 'buy_safely',
  serviceSlug: 'due-diligence',
  preferredTimes: 'Weekday evenings after 18:00',
  message: 'Plot in Epe with a survey plan.',
  marketingConsent: true,
  website: '',
};

describe('normalizePhone', () => {
  it('strips separators and converts 00 prefixes', () => {
    expect(normalizePhone(' +234 (0)801-234.5678 ')).toBe('+2340801234 5678'.replace(/\s/g, ''));
    expect(normalizePhone('00447700900123')).toBe('+447700900123');
  });
});

describe('consultationFormSchema', () => {
  it('accepts a complete submission and an empty optional phone', () => {
    expect(consultationFormSchema.safeParse(valid).success).toBe(true);
    expect(consultationFormSchema.safeParse({ ...valid, phone: '' }).success).toBe(true);
  });

  it('rejects a phone that is not E.164 after normalisation', () => {
    const result = consultationFormSchema.safeParse({ ...valid, phone: '0801 234 5678' });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('phone');
  });

  it('rejects anything typed in the honeypot', () => {
    expect(consultationFormSchema.safeParse({ ...valid, website: 'http://spam' }).success).toBe(
      false,
    );
  });
});

describe('readPrefill', () => {
  it('validates ids, slugs, budgets and interest flags from the URL', () => {
    const prefill = readPrefill({
      service: 'due-diligence',
      goal: 'invest_and_compare',
      scenarioId: '7F1C4C4E-8C29-4E3D-9F5B-2A1C0F1D2E3A',
      marketIds: '11111111-1111-4111-8111-111111111111,not-a-uuid',
      marketId: '22222222-2222-4222-8222-222222222222',
      market: 'ng-ibadan',
      listing: 'plot-12',
      budget: '45,000,000',
      interest: '1',
    });
    expect(prefill).toEqual({
      serviceSlug: 'due-diligence',
      goal: 'invest_and_compare',
      scenarioId: '7f1c4c4e-8c29-4e3d-9f5b-2a1c0f1d2e3a',
      marketIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      marketSlug: 'ng-ibadan',
      listingSlug: 'plot-12',
      budgetNaira: 45_000_000,
      interest: true,
    });
  });

  it('drops invalid values instead of guessing', () => {
    const prefill = readPrefill({
      service: 'Bad Slug',
      goal: 'nope',
      budget: '-5',
      scenarioId: 'x',
    });
    expect(prefill).toEqual({
      serviceSlug: null,
      goal: null,
      scenarioId: null,
      marketIds: [],
      marketSlug: null,
      listingSlug: null,
      budgetNaira: null,
      interest: false,
    });
  });
});

describe('buildConsultationPayload', () => {
  const prefill = readPrefill({
    scenarioId: '7f1c4c4e-8c29-4e3d-9f5b-2a1c0f1d2e3a',
    marketId: '22222222-2222-4222-8222-222222222222',
    budget: '1000000',
    market: 'ng-epe',
  });

  it('produces a payload the API contract accepts, carrying scenario, markets and budget', () => {
    const payload = buildConsultationPayload(valid, {
      prefill,
      elapsedMs: 4200.7,
      source: 'consultation_booking',
    });
    expect(payload.email).toBe('ada@example.com');
    expect(payload.phoneE164).toBe('+2348012345678');
    expect(payload.scenarioId).toBe('7f1c4c4e-8c29-4e3d-9f5b-2a1c0f1d2e3a');
    expect(payload.marketIds).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(payload.budgetNaira).toBe(1_000_000);
    expect(payload.elapsedMs).toBe(4201);
    expect(payload.message).toContain('Location of interest: ng-epe');
    expect(payload.message).toContain(
      'Preferred days and times (Europe/London): Weekday evenings after 18:00',
    );
    expect(payload).not.toHaveProperty('website');
    const { source: _source, ...contractBody } = payload;
    expect(consultationRequestSchema.safeParse(contractBody).success).toBe(true);
  });

  it('keeps an empty phone and message as null', () => {
    const payload = buildConsultationPayload(
      { ...valid, phone: '', message: '', preferredTimes: '' },
      { prefill: readPrefill({}), elapsedMs: 10, source: 'website_form' },
    );
    expect(payload.phoneE164).toBeNull();
    expect(payload.message).toBeNull();
  });

  it('caps the composed message at the contract limit', () => {
    const message = composeMessage({
      message: 'x'.repeat(5000),
      preferredTimes: '',
      timeZone: 'Africa/Lagos',
      interest: true,
      marketSlug: null,
    });
    expect(message?.length).toBe(4000);
    expect(message?.startsWith('Interest registration')).toBe(true);
  });

  it('maps API validation paths back to form fields', () => {
    expect(fieldForApiPath('phoneE164')).toBe('phone');
    expect(fieldForApiPath('contactName')).toBe('contactName');
    expect(fieldForApiPath('unknown')).toBeNull();
  });
});
