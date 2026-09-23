import type { Metadata } from 'next';
import { Badge, DataTable, PageHeader, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listLedgerAccounts } from '@/lib/admin/server/finance';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { Money } from '@/components/admin/money';
import { Mono } from '../../_components/bits';

export const metadata: Metadata = { title: 'Chart of accounts' };
export const dynamic = 'force-dynamic';

export default async function ChartOfAccountsPage() {
  const identity = await requireStaffPage('finance.read');
  const accounts = await listLedgerAccounts(identity);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Chart of accounts"
        description="Read-only. Customer receivables, service revenue, gateway clearing, fees, refunds, rent liabilities and owner distributions are separate accounts; rent collected for owners is a liability, not SimplexD revenue. Balances are the sum of posted journal lines in each account's normal direction."
        actions={
          <ExportCsvButton
            rows={accounts}
            filename="chart-of-accounts.csv"
            columns={[
              { header: 'Code', value: (a) => a.code },
              { header: 'Name', value: (a) => a.name },
              { header: 'Type', value: (a) => a.type },
              { header: 'Normal balance', value: (a) => a.normalBalance },
              { header: 'Debits kobo', value: (a) => a.debitKobo },
              { header: 'Credits kobo', value: (a) => a.creditKobo },
              { header: 'Balance kobo', value: (a) => a.balanceKobo },
            ]}
          />
        }
      />
      <DataTable
        caption="Ledger accounts"
        rows={accounts}
        rowKey={(a) => a.id}
        rowLabel={(a) => `${a.code} ${a.name}`}
        emptyMessage="No ledger accounts are seeded."
        columns={[
          { key: 'code', header: 'Code', cell: (a) => <Mono>{a.code}</Mono> },
          {
            key: 'name',
            header: 'Account',
            cell: (a) => (
              <span>
                {a.name} {a.isControl ? <Badge tone="info">control</Badge> : null} {!a.active ? <Badge>inactive</Badge> : null}
                {a.description ? <span className="block text-xs text-fg-muted">{a.description}</span> : null}
              </span>
            ),
          },
          { key: 'type', header: 'Type', cell: (a) => `${humanize(a.type)}${a.subtype ? ` · ${humanize(a.subtype)}` : ''}`, hideOnMobile: true },
          { key: 'nb', header: 'Normal', cell: (a) => a.normalBalance, hideOnMobile: true },
          { key: 'dr', header: 'Debits', cell: (a) => <Money kobo={a.debitKobo} />, hideOnMobile: true },
          { key: 'cr', header: 'Credits', cell: (a) => <Money kobo={a.creditKobo} />, hideOnMobile: true },
          { key: 'bal', header: 'Balance', cell: (a) => <Money kobo={a.balanceKobo} /> },
        ]}
      />
    </div>
  );
}
