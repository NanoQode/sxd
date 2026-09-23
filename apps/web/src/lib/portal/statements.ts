import type { OwnerStatementDto } from '@simplexd/contracts';

export type StatementLine = OwnerStatementDto['lines'][number];

/** Sum of kobo strings for the given line kinds (BigInt, never floating point). */
export function sumLines(lines: StatementLine[], kinds: StatementLine['kind'][]): string {
  return lines
    .filter((l) => kinds.includes(l.kind))
    .reduce((acc, l) => acc + BigInt(l.amountKobo), 0n)
    .toString();
}

export const STATEMENT_LINE_LABELS: Record<StatementLine['kind'], string> = {
  rent_collected: 'Rent collected',
  service_charge_collected: 'Service charge collected',
  management_fee: 'Management fee',
  maintenance_recovery: 'Maintenance recovery',
  short_stay_income: 'Short-stay income',
  short_stay_expense: 'Short-stay expense',
  arrears: 'Arrears (not collected)',
};
