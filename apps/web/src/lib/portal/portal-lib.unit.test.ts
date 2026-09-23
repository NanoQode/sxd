import { describe, expect, it } from 'vitest';
import {
  formatInZone,
  isPositiveKobo,
  koboToNaira,
  koboToNairaInput,
  nairaInputToKobo,
} from './format';
import { paymentOutcomeCopy } from './payments';
import { STATEMENT_LINE_LABELS, sumLines } from './statements';
import { validateForPurpose } from './upload';

describe('money formatting (integer kobo, no floating point)', () => {
  it('formats kobo strings as naira', () => {
    expect(koboToNaira('50000000')).toBe('₦500,000.00');
    expect(koboToNaira('5')).toBe('₦0.05');
    expect(koboToNaira('-150000')).toBe('-₦1,500.00');
    expect(koboToNaira('123456789012345678901')).toBe('₦1,234,567,890,123,456,789.01');
    expect(koboToNaira(null)).toBe('—');
    expect(koboToNaira('12500', { whole: true })).toBe('₦125');
  });

  it('parses typed naira into kobo', () => {
    expect(nairaInputToKobo('85000')).toBe('8500000');
    expect(nairaInputToKobo('₦12,500.5')).toBe('1250050');
    expect(nairaInputToKobo('0.07')).toBe('7');
    expect(nairaInputToKobo('007')).toBe('700');
    expect(nairaInputToKobo('1.234')).toBeNull();
    expect(nairaInputToKobo('-5')).toBeNull();
    expect(nairaInputToKobo('abc')).toBeNull();
  });

  it('round-trips kobo into an input value', () => {
    expect(koboToNairaInput('8500000')).toBe('85000');
    expect(koboToNairaInput('1250050')).toBe('12500.50');
    expect(nairaInputToKobo(koboToNairaInput('1250050'))).toBe('1250050');
    expect(koboToNairaInput(null)).toBe('');
  });

  it('checks positive balances without Number()', () => {
    expect(isPositiveKobo('1')).toBe(true);
    expect(isPositiveKobo('0')).toBe(false);
    expect(isPositiveKobo('-1')).toBe(false);
    expect(isPositiveKobo(undefined)).toBe(false);
  });
});

describe('time zones', () => {
  it('labels the same instant in the customer and business zones across DST', () => {
    const iso = '2026-10-26T09:00:00.000Z'; // the day after the UK leaves summer time
    expect(formatInZone(iso, 'Africa/Lagos', 'HH:mm')).toBe('10:00');
    expect(formatInZone(iso, 'Europe/London', 'HH:mm')).toBe('09:00');
    expect(formatInZone('2026-10-20T09:00:00.000Z', 'Europe/London', 'HH:mm')).toBe('10:00');
  });
});

describe('paymentOutcomeCopy', () => {
  const base = { developmentAdapter: false, failureReason: null };
  it('only reports received money for a verified successful attempt', () => {
    expect(paymentOutcomeCopy({ ...base, status: 'successful' })).toMatchObject({
      tone: 'success',
      title: 'Payment received',
      recheck: false,
    });
    expect(
      paymentOutcomeCopy({ ...base, status: 'successful', developmentAdapter: true }).body,
    ).toContain('No real money moved');
  });

  it('keeps pending attempts pending and offers a re-check', () => {
    for (const status of ['initialized', 'pending'] as const) {
      expect(paymentOutcomeCopy({ ...base, status })).toMatchObject({
        tone: 'info',
        recheck: true,
      });
    }
  });

  it('never presents uncertain, failed, abandoned or reversed attempts as paid', () => {
    expect(paymentOutcomeCopy({ ...base, status: 'uncertain' }).title).toBe('Payment needs review');
    expect(
      paymentOutcomeCopy({ ...base, status: 'failed', failureReason: 'Declined' }).body,
    ).toContain('Declined');
    expect(paymentOutcomeCopy({ ...base, status: 'abandoned' }).title).toBe('Checkout abandoned');
    expect(paymentOutcomeCopy({ ...base, status: 'reversed' }).tone).toBe('warning');
  });
});

describe('owner statement sums', () => {
  const lines = [
    { kind: 'rent_collected' as const, description: 'Flat A1 rent', amountKobo: '360000000' },
    { kind: 'rent_collected' as const, description: 'Flat A2 rent', amountKobo: '240000000' },
    {
      kind: 'management_fee' as const,
      description: 'Fee 10%',
      amountKobo: '-60000000',
      feeBps: 1000,
    },
    { kind: 'maintenance_recovery' as const, description: 'Tap', amountKobo: '-8500000' },
  ];
  it('adds kobo exactly with BigInt, including negative lines', () => {
    expect(sumLines(lines, ['rent_collected'])).toBe('600000000');
    expect(sumLines(lines, ['management_fee', 'maintenance_recovery'])).toBe('-68500000');
    expect(sumLines(lines, ['arrears'])).toBe('0');
  });
  it('has a label for every line kind', () => {
    expect(Object.keys(STATEMENT_LINE_LABELS)).toHaveLength(7);
  });
});

describe('validateForPurpose', () => {
  it('accepts a PDF document and refuses unsupported or empty files before any upload', () => {
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'plan.pdf', {
      type: 'application/pdf',
    });
    expect(validateForPurpose(pdf, 'org_document')).toBeNull();
    const exe = new File([new Uint8Array([1, 2, 3])], 'setup.exe', {
      type: 'application/x-msdownload',
    });
    expect(validateForPurpose(exe, 'org_document')).toContain('is not accepted for this purpose');
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    expect(validateForPurpose(empty, 'org_document')).toContain('is empty');
  });
});
