'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, useToast } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import { ActionDialog } from '../_components/action-dialog';

interface RewrapResponse {
  jobId: string;
  deduplicated: boolean;
  masterKeyId: string;
  pending: number;
  total: number;
}

/** Enqueues the master-key re-wrap job; never touches secret values in the browser. */
export function RewrapButton({ pending, masterKeyId, disabled }: { pending: number; masterKeyId: string; disabled: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  async function confirm() {
    const res = await apiFetch<RewrapResponse>('/api/v1/admin/integrations/rewrap', { method: 'POST', body: {} });
    toast({
      title: res.deduplicated ? 'Re-wrap already queued' : 'Re-wrap queued',
      description: `${res.pending} of ${res.total} secrets will be re-wrapped under ${res.masterKeyId}.`,
      tone: 'success',
    });
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={disabled} title={disabled ? 'Requires a verified authenticator' : undefined}>
        Re-wrap secrets{pending > 0 ? ` (${pending})` : ''}
      </Button>
      <ActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Re-wrap stored secrets"
        description={`Re-encrypts every stored secret's data key under the current master key (${masterKeyId}). Secrets are never shown or moved in plaintext outside the worker process. Run this after rotating SECRETS_MASTER_KEY while the previous key is still configured.`}
        confirmLabel="Queue re-wrap job"
        onConfirm={confirm}
      />
    </>
  );
}
