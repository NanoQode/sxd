'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Switch,
  useToast,
} from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import type { DataPolicyDto } from '@/server/admin/market-data/policies';
import { ActionDialog } from '../../_components/action-dialog';
import { fmtDate } from '../../_components/bits';

export function DataPoliciesEditor({
  items,
  rankEligibleEvidence,
  canManage,
}: {
  items: DataPolicyDto[];
  rankEligibleEvidence: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<DataPolicyDto | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [bool, setBool] = useState(false);

  function open(p: DataPolicyDto) {
    setEditing(p);
    setDraft(p.value === null ? '' : String(p.value));
    setBool(Boolean(p.value));
  }

  async function save(reason: string) {
    if (!editing) return;
    const isBool =
      typeof editing.value === 'boolean' ||
      editing.key.endsWith('_enabled') ||
      editing.key.includes('require');
    const value = isBool ? bool : Number(draft);
    await apiFetch(`/api/v1/admin/data-policies/${editing.key}`, {
      method: 'PATCH',
      body: { value, reason, expectedUpdatedAt: editing.updatedBy ? editing.updatedAt : undefined },
    });
    toast({ title: `${editing.key} updated`, tone: 'success' });
    router.refresh();
  }

  const isBoolean = (p: DataPolicyDto) =>
    typeof p.value === 'boolean' || p.key.endsWith('_enabled') || p.key.includes('require');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {items.map((p) => (
          <Card key={p.key}>
            <CardHeader>
              <CardTitle>
                <code className="font-mono text-sm break-all">{p.key}</code>
              </CardTitle>
              <CardDescription>{p.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="font-display text-2xl font-semibold">
                {p.value === null ? '—' : String(p.value)}
              </p>
              {p.key === 'default_financial_ranking_enabled' ? (
                <Alert
                  tone={rankEligibleEvidence === 0 ? 'warning' : 'info'}
                  title={`${rankEligibleEvidence} published rank-eligible observation(s)`}
                >
                  {rankEligibleEvidence === 0
                    ? 'The research seed contains no rank-eligible evidence. Enabling default financial ranking would rank on assumptions; keep it off until local cost and rent evidence is published and marked rank-eligible.'
                    : 'Evidence-mode ranking only uses published, rank-eligible, fresh local observations.'}
                </Alert>
              ) : null}
              <p className="text-xs text-fg-muted">
                Updated {p.updatedBy ? fmtDate(p.updatedAt) : 'never'}
              </p>
              {canManage ? (
                <Button size="sm" variant="secondary" onClick={() => open(p)}>
                  Change
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
      <ActionDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Change ${editing.key}` : ''}
        description={editing?.description ?? undefined}
        confirmLabel="Save"
        requireReason
        confirmText={
          editing?.key === 'default_financial_ranking_enabled' && bool
            ? 'enable ranking'
            : undefined
        }
        onConfirm={save}
      >
        {editing && isBoolean(editing) ? (
          <div className="flex items-center gap-3">
            <Switch checked={bool} onCheckedChange={setBool} label={editing.key} />
            <span className="text-sm">{bool ? 'Enabled' : 'Disabled'}</span>
          </div>
        ) : editing ? (
          <Field label="Value" required>
            {({ id }) => (
              <Input
                id={id}
                type="number"
                step="any"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        {editing?.key === 'default_financial_ranking_enabled' &&
        bool &&
        rankEligibleEvidence === 0 ? (
          <Alert tone="warning" title="No eligible evidence">
            Ranking would run without any rank-eligible local evidence. Type the confirmation phrase
            to proceed anyway.
          </Alert>
        ) : null}
      </ActionDialog>
    </div>
  );
}
