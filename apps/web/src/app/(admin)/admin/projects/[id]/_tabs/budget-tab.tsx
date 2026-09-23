import { Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listBudgetVersions, listCommitments } from '@/server/projects/budgets';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../../_components/bits';
import { BoqEditor, NewBudgetVersion } from '../_components/budget-editor';

export async function BudgetTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const [versions, commitments] = await Promise.all([
    listBudgetVersions(identity, p.id).then((r) => r.items),
    listCommitments(identity, p.id, { limit: 100 }).then((r) => r.items),
  ]);
  const v = shell.overview.budget.variance;
  const canManage = shell.permissions.manage;
  return (
    <div className="space-y-6">
      <Section title="Variance and forecast" description="Commitment-based: approved base + contingency versus committed and actual. Approved change orders move the approved total; pending ones are shown separately.">
        <DefinitionList
          items={[
            { term: 'Approved base', value: v.approvedBaseKobo ? <Money kobo={v.approvedBaseKobo} /> : 'no approved budget' },
            { term: 'Contingency', value: <Money kobo={v.contingencyKobo} /> },
            { term: 'Approved total', value: v.approvedTotalKobo ? <Money kobo={v.approvedTotalKobo} /> : null },
            { term: 'Committed', value: <Money kobo={v.committedKobo} /> },
            { term: 'Actual', value: <Money kobo={v.actualKobo} /> },
            { term: 'Exposure (committed + actual)', value: <Money kobo={v.exposureKobo} /> },
            { term: 'Remaining', value: v.remainingKobo ? <Money kobo={v.remainingKobo} /> : null },
            { term: 'Forecast final cost', value: v.forecastFinalCostKobo ? <Money kobo={v.forecastFinalCostKobo} /> : null },
            { term: 'Variance', value: v.varianceKobo ? <span><Money kobo={v.varianceKobo} />{v.variancePct !== null ? ` (${v.variancePct.toFixed(1)}%)` : ''}</span> : null },
            { term: 'Approved change orders', value: <Money kobo={v.approvedChangeOrderDeltaKobo} /> },
            { term: 'Pending change orders', value: <Money kobo={v.pendingChangeOrderDeltaKobo} /> },
            { term: 'Status', value: <Badge tone={v.status === 'within_budget' ? 'success' : v.status === 'no_approved_budget' ? 'neutral' : 'danger'}>{humanize(v.status)}</Badge> },
          ]}
        />
        {v.progressExtrapolation ? (
          <p className="text-xs text-fg-muted">
            Progress extrapolation ({v.progressExtrapolation.percentComplete}% complete): <Money kobo={v.progressExtrapolation.finalCostKobo} /> — a scenario, not a forecast.
          </p>
        ) : null}
      </Section>

      <Section
        title={`Budget versions (${versions.length})`}
        description="A version becomes the project budget only when the approval policy (customer and/or staff) is satisfied. Approved versions are immutable; changes go through change orders."
        actions={canManage ? <NewBudgetVersion projectId={p.id} hasArea={Boolean(p.grossFloorAreaM2)} /> : null}
      >
        {versions.length === 0 ? <p className="text-fg-muted">No budget version yet.</p> : null}
        <div className="space-y-4">
          {versions.map((bv) => (
            <div key={bv.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">Version {bv.version}</span> <StatusBadge status={bv.status === 'approved' ? 'accepted' : bv.status} label={humanize(bv.status)} />{' '}
                  <span className="text-xs text-fg-muted">{humanize(bv.source)} · created {formatDateTimeLabel(bv.createdAt)}</span>
                </div>
                <span className="font-medium">
                  <Money kobo={bv.totalKobo} currency={bv.currency} /> {bv.contingencyKobo !== '0' ? <span className="text-xs text-fg-muted">+ contingency <Money kobo={bv.contingencyKobo} /></span> : null}
                </span>
              </div>
              {bv.buildRateKoboPerM2 ? (
                <p className="text-xs text-fg-muted">
                  <Money kobo={bv.buildRateKoboPerM2} /> per m² × {bv.areaM2 ?? '?'} m²
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <Badge tone={bv.approvalPolicy.outcome === 'approved' ? 'success' : bv.approvalPolicy.outcome === 'rejected' ? 'danger' : 'warning'}>
                  Policy: {humanize(bv.approvalPolicy.outcome)}
                  {bv.approvalPolicy.missing.length > 0 ? ` · missing ${bv.approvalPolicy.missing.join(', ')}` : ''}
                </Badge>
                {bv.approvals.map((a) => (
                  <Badge key={a.id} tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : 'neutral'}>
                    {humanize(a.approverRole)}: {humanize(a.status)}
                  </Badge>
                ))}
              </div>
              {bv.status === 'draft' && canManage && bv.approvalPolicy.requiresStaffApproval && !bv.approvals.some((a) => a.approverRole === 'staff' && a.status !== 'pending') ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <ApiAction path={`/api/v1/budgets/${bv.id}/decisions`} label="Approve (staff)" variant="primary" body={{ decision: 'approved' }} reasonKey="note" confirm={{ title: `Approve budget version ${bv.version}?`, description: 'Becomes the approved budget only once every required approval is present.', confirmLabel: 'Approve' }} successMessage="Decision recorded" />
                  <ApiAction path={`/api/v1/budgets/${bv.id}/decisions`} label="Reject" variant="danger" body={{ decision: 'rejected' }} reasonKey="note" confirm={{ title: 'Reject this version?', requireReason: true, confirmLabel: 'Reject', tone: 'danger' }} successMessage="Version rejected" />
                </div>
              ) : null}
              {bv.items.length > 0 || (bv.status === 'draft' && bv.source === 'boq' && canManage) ? (
                <details className="mt-2" open={bv.status === 'draft'}>
                  <summary className="cursor-pointer text-sm text-fg-muted">Bill of quantities ({bv.items.length} items)</summary>
                  <BoqEditor budgetId={bv.id} items={bv.items} editable={bv.status === 'draft' && canManage && bv.approvals.every((a) => a.status === 'pending')} />
                </details>
              ) : null}
              {bv.inclusions ? <p className="mt-2 text-xs"><strong>Inclusions:</strong> {bv.inclusions}</p> : null}
              {bv.notes ? <p className="text-xs"><strong>Notes:</strong> {bv.notes}</p> : null}
            </div>
          ))}
        </div>
      </Section>

      <Section
        title={`Commitments and actuals (${commitments.length})`}
        description="Append-only. Commitments are purchase orders and contracts; actuals are invoices paid or costs incurred."
        actions={
          canManage ? (
            <FormDialog
              trigger="Record commitment / actual"
              title="Record a commitment or actual"
              path={`/api/v1/projects/${p.id}/commitments`}
              successMessage="Recorded"
              fields={[
                { name: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'commitment', label: 'Commitment' }, { value: 'actual', label: 'Actual' }] },
                { name: 'amountKobo', label: 'Amount (₦)', type: 'naira', required: true },
                { name: 'description', label: 'Description', required: true, wide: true },
                { name: 'counterparty', label: 'Counterparty', emptyAs: 'null' },
                { name: 'reference', label: 'Reference', emptyAs: 'null' },
                { name: 'incurredAt', label: 'Date', type: 'date', emptyAs: 'null' },
              ]}
            />
          ) : null
        }
      >
        {commitments.length === 0 ? (
          <p className="text-fg-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {commitments.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Badge tone={c.kind === 'actual' ? 'primary' : 'neutral'}>{humanize(c.kind)}</Badge> {c.description}
                  <span className="block text-xs text-fg-muted">
                    {c.counterparty ?? ''} {c.reference ? `· ${c.reference}` : ''} {c.incurredAt ? `· ${c.incurredAt}` : ''}
                  </span>
                </span>
                <Money kobo={c.amountKobo} currency={c.currency} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
