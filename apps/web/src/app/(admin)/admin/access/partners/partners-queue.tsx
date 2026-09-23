'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, DataTable, Field, Input, StatusBadge, useToast, type Column } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import type { PartnerQueueItem } from '@/server/admin/access/partners';
import { ActionDialog } from '../../_components/action-dialog';
import { JsonBlock, fmtDate } from '../../_components/bits';

export function PartnersQueue({ items }: { items: PartnerQueueItem[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<{ p: PartnerQueueItem; decision: 'verify' | 'reject' } | null>(null);
  const [expires, setExpires] = useState('');

  async function decide(scopeNote: string) {
    if (!pending) return;
    await apiFetch(`/api/v1/admin/partners/${pending.p.id}/verify`, { method: 'POST', body: { decision: pending.decision, scopeNote, expiresAt: expires ? new Date(expires).toISOString() : null } });
    toast({ title: `${pending.p.displayName}: ${pending.decision === 'verify' ? 'verified' : 'rejected'}`, tone: 'success' });
    router.refresh();
  }

  const columns: Column<PartnerQueueItem>[] = [
    { key: 'name', header: 'Partner', cell: (p) => <span className="font-medium">{p.displayName}<span className="block text-xs text-fg-muted">{p.userName} · {p.email}</span></span> },
    { key: 'type', header: 'Type', cell: (p) => <Badge tone="neutral">{p.partnerType.replace(/_/g, ' ')}</Badge> },
    { key: 'status', header: 'Verification', cell: (p) => <StatusBadge status={p.verificationStatus} /> },
    { key: 'scope', header: 'Scope checked', hideOnMobile: true, cell: (p) => <span className="text-xs">{p.verificationScope ?? '—'}{p.verificationExpiresAt ? ` · expires ${fmtDate(p.verificationExpiresAt)}` : ''}</span> },
    { key: 'credentials', header: 'Credentials', hideOnMobile: true, cell: (p) => (p.credentials && p.credentials.length > 0 ? <details className="text-xs"><summary className="cursor-pointer text-primary">{p.credentials.length} listed</summary><JsonBlock value={p.credentials} /></details> : <span className="text-xs text-fg-muted">None listed</span>) },
    { key: 'disclosures', header: 'Conflicts', hideOnMobile: true, cell: (p) => <span className="text-xs">{p.conflictDisclosures ?? '—'}</span> },
    { key: 'actions', header: 'Actions', cell: (p) => (
      <div className="flex gap-1">
        {p.verificationStatus !== 'verified' ? <Button size="sm" onClick={() => setPending({ p, decision: 'verify' })}>Verify</Button> : null}
        {p.verificationStatus !== 'rejected' ? <Button size="sm" variant="secondary" onClick={() => setPending({ p, decision: 'reject' })}>Reject</Button> : null}
      </div>
    ) },
  ];

  return (
    <div className="space-y-4">
      <DataTable columns={columns} rows={items} rowKey={(p) => p.id} rowLabel={(p) => p.displayName} caption="Partner profiles" emptyMessage="No partner profiles yet." />
      <ActionDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? `${pending.decision === 'verify' ? 'Verify' : 'Reject'} ${pending.p.displayName}` : ''}
        description="Describe what was checked (credentials, registration numbers, references) and its limits."
        confirmLabel={pending?.decision === 'verify' ? 'Verify' : 'Reject'}
        tone={pending?.decision === 'reject' ? 'danger' : 'primary'}
        requireReason
        reasonLabel="Scope of verification (shown as the badge explanation)"
        onConfirm={decide}
      >
        {pending?.decision === 'verify' ? (
          <Field label="Verification expires" hint="Optional; for credentials with an expiry date.">
            {({ id }) => <Input id={id} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}
          </Field>
        ) : null}
      </ActionDialog>
    </div>
  );
}
