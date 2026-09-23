/**
 * Naira text input ↔ kobo integer strings. Amounts travel as decimal kobo
 * strings (never floats): "1,250,000.50" naira → "125000050" kobo.
 */

export function nairaInputToKobo(input: string): string | null {
  const cleaned = input.replace(/[,\s₦]/g, '').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const kobo = `${whole}${frac.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return kobo === '' ? '0' : kobo;
}

export function koboToNairaInput(kobo: string | null | undefined): string {
  if (!kobo || !/^\d+$/.test(kobo)) return '';
  const padded = kobo.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = padded.slice(-2);
  return frac === '00' ? whole : `${whole}.${frac}`;
}

export function sumKobo(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) if (v && /^\d+$/.test(v)) total += BigInt(v);
  return total.toString();
}

export function multiplyKobo(rateKobo: string, quantity: string): string | null {
  if (!/^\d+$/.test(rateKobo) || !/^\d+(\.\d+)?$/.test(quantity)) return null;
  const [whole, frac = ''] = quantity.split('.');
  const scale = BigInt(10) ** BigInt(frac.length);
  const q = BigInt(`${whole}${frac}`);
  const product = BigInt(rateKobo) * q;
  // Round half up to whole kobo.
  return ((product + scale / 2n) / scale).toString();
}
