'use client';

import { Button, Input } from '@simplexd/ui';
import { lineAmountKobo, parseNairaToKobo, sumKobo } from '@/lib/admin/money';
import { Money } from '@/components/admin/money';

export interface DraftLine {
  description: string;
  quantity: string;
  unitNaira: string;
}

export const EMPTY_LINE: DraftLine = { description: '', quantity: '1', unitNaira: '' };

export interface ParsedLines {
  valid: boolean;
  subtotalKobo: string;
  lines: Array<{ description: string; quantity: string; unitAmountKobo: string }>;
}

export function parseLines(lines: DraftLine[]): ParsedLines {
  const out: ParsedLines['lines'] = [];
  let valid = lines.length > 0;
  for (const l of lines) {
    const unit = parseNairaToKobo(l.unitNaira);
    const qtyOk = /^\d+(\.\d{1,3})?$/.test(l.quantity);
    if (!l.description.trim() || !unit || unit.startsWith('-') || !qtyOk) valid = false;
    out.push({ description: l.description.trim(), quantity: l.quantity, unitAmountKobo: unit ?? '0' });
  }
  return {
    valid,
    subtotalKobo: sumKobo(out.map((l) => lineAmountKobo(l.quantity, l.unitAmountKobo))),
    lines: out,
  };
}

/** Quote line editor shared by the quotation template form (amounts in whole naira). */
export function LinesEditor({ lines, onChange }: { lines: DraftLine[]; onChange: (next: DraftLine[]) => void }) {
  const parsed = parseLines(lines);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Lines</p>
      {lines.map((l, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[3fr_1fr_1.5fr_auto]">
          <Input
            aria-label={`Line ${i + 1} description`}
            placeholder="Description"
            value={l.description}
            onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
          />
          <Input
            aria-label={`Line ${i + 1} quantity`}
            placeholder="Qty"
            value={l.quantity}
            onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
          />
          <Input
            aria-label={`Line ${i + 1} unit amount in naira`}
            placeholder="Unit ₦"
            inputMode="decimal"
            value={l.unitNaira}
            onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, unitNaira: e.target.value } : x)))}
            aria-invalid={l.unitNaira !== '' && !parseNairaToKobo(l.unitNaira)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove line ${i + 1}`}
            disabled={lines.length === 1}
            onClick={() => onChange(lines.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => onChange([...lines, { ...EMPTY_LINE }])}>
          Add line
        </Button>
        <span className="text-sm">
          Subtotal (before tax): <Money kobo={parsed.subtotalKobo} />
        </span>
      </div>
    </div>
  );
}
