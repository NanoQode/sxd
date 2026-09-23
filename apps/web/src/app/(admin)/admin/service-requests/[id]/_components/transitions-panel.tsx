'use client';

import { useState } from 'react';
import { Field, NativeSelect, humanize } from '@simplexd/ui';
import { ApiAction } from '@/components/admin/api-action';

const BILLING = ['none', 'void_unpaid_invoices', 'invoice_pro_rata', 'refund_per_policy'] as const;

const LABELS: Record<string, string> = {
  rejected: 'Reject',
  paused: 'Pause',
  in_progress: 'Resume / start work',
  cancelled: 'Cancel',
  in_review: 'Send to review',
  delivered: 'Deliver to customer',
  completed: 'Complete',
};

export function TransitionsPanel({
  requestId,
  version,
  transitions,
  permissions,
}: {
  requestId: string;
  version: number;
  transitions: Array<{ to: string; reasonRequired: boolean; effect: string | null }>;
  permissions: { triage: boolean; override: boolean };
}) {
  const [billing, setBilling] = useState<string>('');
  if (transitions.length === 0)
    return (
      <p className="text-fg-muted">No staff transitions are available from the current status.</p>
    );
  const showBilling = transitions.some((t) => t.to === 'cancelled');
  return (
    <div className="space-y-3">
      {showBilling ? (
        <Field
          label="Billing consequence for cancellation"
          hint="Defaults to the policy for the current status when left blank."
        >
          {({ id }) => (
            <NativeSelect id={id} value={billing} onChange={(e) => setBilling(e.target.value)}>
              <option value="">Policy default</option>
              {BILLING.map((b) => (
                <option key={b} value={b}>
                  {humanize(b)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      <ul className="space-y-2">
        {transitions.map((t) => (
          <li
            key={t.to}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
          >
            <span className="text-sm">
              <strong>{LABELS[t.to] ?? humanize(t.to)}</strong>
              {t.effect ? <span className="block text-xs text-fg-muted">{t.effect}</span> : null}
            </span>
            <ApiAction
              path={`/api/v1/service-requests/${requestId}/transitions/staff`}
              label={LABELS[t.to] ?? humanize(t.to)}
              variant={t.to === 'cancelled' || t.to === 'rejected' ? 'danger' : 'secondary'}
              body={(reason) => ({
                to: t.to,
                reason: reason || undefined,
                billingConsequence: t.to === 'cancelled' && billing ? billing : undefined,
                expectedVersion: version,
              })}
              confirm={{
                title: `${LABELS[t.to] ?? humanize(t.to)}?`,
                description: t.effect ?? 'The transition is recorded with your name and the time.',
                requireReason: t.reasonRequired,
                confirmLabel: LABELS[t.to] ?? humanize(t.to),
                tone: t.to === 'cancelled' || t.to === 'rejected' ? 'danger' : 'primary',
              }}
              successMessage={`Request moved to ${humanize(t.to)}`}
              disabled={!permissions.triage && !permissions.override}
              disabledReason="Transitions need service_requests.triage or service_requests.override"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
