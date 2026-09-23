'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RankingPolicyDto } from '@simplexd/contracts';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  StatusBadge,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { Alert } from '@simplexd/ui';
import { fmtDate } from '../../_components/bits';

export function PoliciesList({
  items,
  canManage,
}: {
  items: RankingPolicyDto[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const draft = await apiFetch<RankingPolicyDto>('/api/v1/admin/ranking-policies', {
        body: { name },
      });
      toast({ title: `Draft v${draft.version} created`, tone: 'success' });
      setOpen(false);
      router.push(`/admin/market-data/ranking-policies/${draft.version}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<RankingPolicyDto>[] = [
    {
      key: 'version',
      header: 'Version',
      cell: (p) => (
        <Link
          href={`/admin/market-data/ranking-policies/${p.version}`}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          v{p.version} · {p.name}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => (
        <StatusBadge
          status={
            p.status === 'active' ? 'connected' : p.status === 'retired' ? 'archived' : 'draft'
          }
          label={p.status}
        />
      ),
    },
    {
      key: 'errors',
      header: 'Validation',
      cell: (p) =>
        p.errors.length === 0 ? (
          <Badge tone="success">Valid</Badge>
        ) : (
          <Badge tone="danger">{p.errors.length} error(s)</Badge>
        ),
    },
    {
      key: 'threshold',
      header: 'Coverage / comparables',
      cell: (p) => `${p.coverageThreshold} / ${p.minComparables}`,
    },
    {
      key: 'activated',
      header: 'Activated',
      cell: (p) => <span className="text-xs">{fmtDate(p.activatedAt)}</span>,
    },
    {
      key: 'retired',
      header: 'Retired',
      hideOnMobile: true,
      cell: (p) => <span className="text-xs">{fmtDate(p.retiredAt)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => setOpen(true)}>Create draft from active</Button>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(p) => p.id}
        rowLabel={(p) => `Policy v${p.version}`}
        caption="Ranking policy versions"
      />
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent
          title="New draft policy"
          description="Copies the active version; edit it, then activate."
          size="sm"
        >
          <div className="space-y-4">
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <Field label="Name" required>
              {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={create}
                loading={busy}
                loadingLabel="Creating"
                disabled={name.trim().length < 3}
              >
                Create draft
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
