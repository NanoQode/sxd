/**
 * Chart of accounts used by the posting builders. Codes and names mirror the
 * seeded chart in packages/db/src/seed/reference.ts (`chartOfAccounts`), which
 * is the persisted source of truth; keep both in step.
 */

export const ACCOUNTS = {
  BANK: '1000',
  GATEWAY_CLEARING: '1100',
  CUSTOMER_RECEIVABLES: '1200',
  RENT_RECEIVABLE_ON_BEHALF_OF_OWNERS: '1300',
  BANK_TRANSFERS_PENDING_CONFIRMATION: '1400',
  CUSTOMER_DEPOSITS_AND_UNEARNED_REVENUE: '2000',
  RENT_COLLECTED_PAYABLE_TO_OWNERS: '2100',
  REFUNDS_PAYABLE: '2200',
  TAX_AND_WITHHOLDING_PAYABLE: '2300',
  PARTNER_AND_SUPPLIER_PAYABLES: '2400',
  CHARGEBACKS_PENDING: '2500',
  RETAINED_EARNINGS: '3000',
  SERVICE_REVENUE: '4000',
  MANAGEMENT_FEE_REVENUE: '4100',
  TENDER_AND_PROCUREMENT_FEE_REVENUE: '4200',
  REFERRAL_AND_PLACEMENT_REVENUE: '4300',
  GATEWAY_FEES: '5000',
  REFUND_AND_CHARGEBACK_LOSSES: '5100',
  MAINTENANCE_AND_ESTATE_EXPENSES_RECOVERABLE: '5200',
  PARTNER_PROFESSIONAL_FEES: '5300',
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type NormalBalance = 'debit' | 'credit';

export interface AccountDefinition {
  code: AccountCode;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
}

export const CHART_OF_ACCOUNTS: readonly AccountDefinition[] = [
  { code: '1000', name: 'Bank - operating', type: 'asset', normalBalance: 'debit' },
  { code: '1100', name: 'Gateway clearing - Paystack', type: 'asset', normalBalance: 'debit' },
  { code: '1200', name: 'Customer receivables', type: 'asset', normalBalance: 'debit' },
  {
    code: '1300',
    name: 'Rent receivable (collected on behalf of owners)',
    type: 'asset',
    normalBalance: 'debit',
  },
  {
    code: '1400',
    name: 'Bank transfers pending confirmation',
    type: 'asset',
    normalBalance: 'debit',
  },
  {
    code: '2000',
    name: 'Customer deposits and unearned revenue',
    type: 'liability',
    normalBalance: 'credit',
  },
  {
    code: '2100',
    name: 'Rent collected - payable to owners',
    type: 'liability',
    normalBalance: 'credit',
  },
  { code: '2200', name: 'Refunds payable', type: 'liability', normalBalance: 'credit' },
  { code: '2300', name: 'Tax and withholding payable', type: 'liability', normalBalance: 'credit' },
  {
    code: '2400',
    name: 'Partner and supplier payables',
    type: 'liability',
    normalBalance: 'credit',
  },
  { code: '2500', name: 'Chargebacks pending', type: 'liability', normalBalance: 'credit' },
  { code: '3000', name: 'Retained earnings', type: 'equity', normalBalance: 'credit' },
  { code: '4000', name: 'Service revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '4100', name: 'Management fee revenue', type: 'revenue', normalBalance: 'credit' },
  {
    code: '4200',
    name: 'Tender and procurement fee revenue',
    type: 'revenue',
    normalBalance: 'credit',
  },
  {
    code: '4300',
    name: 'Referral and placement revenue',
    type: 'revenue',
    normalBalance: 'credit',
  },
  { code: '5000', name: 'Gateway fees', type: 'expense', normalBalance: 'debit' },
  { code: '5100', name: 'Refund and chargeback losses', type: 'expense', normalBalance: 'debit' },
  {
    code: '5200',
    name: 'Maintenance and estate expenses (recoverable)',
    type: 'expense',
    normalBalance: 'debit',
  },
  { code: '5300', name: 'Partner professional fees', type: 'expense', normalBalance: 'debit' },
];

export const ACCOUNT_CODES: readonly AccountCode[] = CHART_OF_ACCOUNTS.map((a) => a.code);

const BY_CODE = new Map<string, AccountDefinition>(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export function isAccountCode(value: string): value is AccountCode {
  return BY_CODE.has(value);
}

export function accountDefinition(code: AccountCode): AccountDefinition {
  const def = BY_CODE.get(code);
  if (!def) throw new Error(`unknown ledger account ${code}`);
  return def;
}

/** Revenue accounts a posting may credit. Rent collected for owners is never one of these. */
export type RevenueAccount =
  | typeof ACCOUNTS.SERVICE_REVENUE
  | typeof ACCOUNTS.MANAGEMENT_FEE_REVENUE
  | typeof ACCOUNTS.TENDER_AND_PROCUREMENT_FEE_REVENUE
  | typeof ACCOUNTS.REFERRAL_AND_PLACEMENT_REVENUE;

export const REVENUE_ACCOUNTS: readonly RevenueAccount[] = [
  ACCOUNTS.SERVICE_REVENUE,
  ACCOUNTS.MANAGEMENT_FEE_REVENUE,
  ACCOUNTS.TENDER_AND_PROCUREMENT_FEE_REVENUE,
  ACCOUNTS.REFERRAL_AND_PLACEMENT_REVENUE,
];

export function isRevenueAccount(code: string): code is RevenueAccount {
  return (REVENUE_ACCOUNTS as readonly string[]).includes(code);
}
