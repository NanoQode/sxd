'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Switch, useToast } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import type { FeatureFlagDto } from '@/server/admin/platform/feature-flags';
import { ActionDialog } from '../../_components/action-dialog';
import { fmtDate } from '../../_components/bits';

const CATEGORY_LABEL: Record<string, string> = { core: 'Core', expansion: 'Expansion workflows', regulated_gated: 'Regulated (review required)', experimental: 'Experimental' };

export function FeatureFlagsManager({ items }: { items: FeatureFlagDto[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<{ flag: FeatureFlagDto; enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(flag: FeatureFlagDto, enabled: boolean) {
    if (flag.requiresReview || flag.category === 'regulated_gated') {
      setPending({ flag, enabled });
      return;
    }
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/feature-flags/${flag.key}`, { method: 'PATCH', body: { enabled, expectedUpdatedAt: flag.updatedAt } });
      toast({ title: `${flag.name} ${enabled ? 'enabled' : 'disabled'}`, tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function confirm(reason: string) {
    if (!pending) return;
    await apiFetch(`/api/v1/admin/feature-flags/${pending.flag.key}`, { method: 'PATCH', body: { enabled: pending.enabled, reason, confirmKey: pending.flag.key, expectedUpdatedAt: pending.flag.updatedAt } });
    toast({ title: `${pending.flag.name} ${pending.enabled ? 'enabled' : 'disabled'}`, tone: 'success' });
    router.refresh();
  }

  const groups = ['core', 'expansion', 'regulated_gated', 'experimental'].map((c) => ({ c, flags: items.filter((f) => f.category === c) })).filter((g) => g.flags.length > 0);

  return (
    <div className="space-y-6">
      {error ? <Alert tone="danger" title="Could not change the flag">{error}</Alert> : null}
      {groups.map((g) => (
        <section key={g.c} aria-labelledby={`ff-${g.c}`} className="space-y-2">
          <h2 id={`ff-${g.c}`} className="text-lg font-semibold">{CATEGORY_LABEL[g.c] ?? g.c}</h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-bg-elevated">
            {g.flags.map((f) => (
              <li key={f.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">{f.name} <code className="ml-1 font-mono text-xs text-fg-muted">{f.key}</code></p>
                  {f.description ? <p className="text-sm text-fg-muted">{f.description}</p> : null}
                  {f.reviewNote ? <p className="mt-1 text-xs text-warning">{f.reviewNote}</p> : null}
                  <p className="mt-1 text-xs text-fg-subtle">Updated {fmtDate(f.updatedAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {f.requiresReview ? <Badge tone="warning">Review required</Badge> : null}
                  <Switch checked={f.enabled} onCheckedChange={(v) => void toggle(f, v)} label={`${f.name} enabled`} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <ActionDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? `${pending.enabled ? 'Enable' : 'Disable'} ${pending.flag.name}` : ''}
        description={pending?.flag.reviewNote ?? 'This flag requires a recorded review note.'}
        confirmLabel={pending?.enabled ? 'Enable' : 'Disable'}
        tone={pending?.enabled && pending.flag.category === 'regulated_gated' ? 'danger' : 'primary'}
        requireReason
        reasonLabel="Review note (who reviewed, what operating model and providers are in place)"
        confirmText={pending?.enabled && pending.flag.category === 'regulated_gated' ? pending.flag.key : undefined}
        onConfirm={confirm}
      >
        {pending?.flag.category === 'regulated_gated' && pending.enabled ? (
          <Alert tone="danger" title="Regulated feature">Not an ordinary portal feature. Enabling without a compliant operating model, licensed providers and professional review is prohibited.</Alert>
        ) : null}
      </ActionDialog>
    </div>
  );
}
