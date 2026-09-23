'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SuppressionDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Field,
  Input,
  NativeSelect,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../_components/action-dialog';
import { Mono, fmtDate } from '../../_components/bits';
import { CHANNEL_LABELS, SUPPRESSION_KIND_LABELS } from '../_lib/labels';

const KIND_TONE: Record<SuppressionDto['kind'], 'warning' | 'danger' | 'neutral'> = {
  stop_reply: 'warning',
  hard_bounce: 'danger',
  complaint: 'danger',
  other: 'neutral',
};

export function SuppressionsTable({ items }: { items: SuppressionDto[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [target, setTarget] = useState<SuppressionDto | null>(null);

  async function remove(reason: string) {
    if (!target) return;
    const res = await apiFetch<{ removed: SuppressionDto; consentStillOptedOut: boolean }>(
      `/api/v1/admin/notifications/suppressions/${target.id}/remove`,
      { method: 'POST', body: { reason } },
    );
    toast({
      title: `Suppression removed for ${res.removed.addressMasked}`,
      description: res.consentStillOptedOut
        ? 'The recorded STOP opt-out stays: transactional and marketing SMS remain blocked until the person replies START.'
        : 'Recorded in the audit log with your reason.',
      tone: 'success',
    });
    router.refresh();
  }

  const columns: Column<SuppressionDto>[] = [
    {
      key: 'channel',
      header: 'Channel',
      cell: (s) => <Badge tone="neutral">{CHANNEL_LABELS[s.channel] ?? s.channel}</Badge>,
    },
    { key: 'address', header: 'Address', cell: (s) => <Mono>{s.addressMasked}</Mono> },
    {
      key: 'kind',
      header: 'Reason',
      cell: (s) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone={KIND_TONE[s.kind]}>{SUPPRESSION_KIND_LABELS[s.kind]}</Badge>
          {s.kind === 'other' ? <Mono>{s.reason}</Mono> : null}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (s) => <span className="text-xs">{s.source ?? '—'}</span>,
      hideOnMobile: true,
    },
    {
      key: 'since',
      header: 'Since',
      cell: (s) => <span className="text-xs">{fmtDate(s.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (s) => (
        <Button size="sm" variant="secondary" onClick={() => setTarget(s)}>
          Remove…
        </Button>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(s) => s.id}
        rowLabel={(s) => `${s.channel} ${s.addressMasked}`}
        caption="Suppressed addresses"
        emptyMessage="No suppressions match. STOP replies arrive through the Termii webhook; bounces are recorded below."
      />
      <ActionDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`Remove the suppression for ${target?.addressMasked ?? ''}`}
        description={
          target?.kind === 'stop_reply'
            ? 'This person replied STOP. Removing the suppression lets security messages (such as verification codes) through again; their recorded opt-out still blocks transactional and marketing SMS until they reply START. Only do this at the person’s request.'
            : target?.kind === 'complaint'
              ? 'This address filed a spam complaint. Sending again without their explicit request risks the sender reputation.'
              : 'Hard bounces usually mean the address does not exist; remove only after the person confirmed the address works.'
        }
        confirmLabel="Remove suppression"
        tone="danger"
        requireReason
        onConfirm={remove}
      />
    </>
  );
}

/** Manual bounce/complaint intake while no SMTP feedback webhook is configured. */
export function BounceImportForm() {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'hard' | 'soft' | 'complaint'>('hard');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ attemptId: string | null; suppressed: boolean }>(
        '/api/v1/admin/notifications/bounces',
        { method: 'POST', body: { email, kind, reason: reason || null } },
      );
      toast({
        title: res.suppressed ? 'Address suppressed' : 'Soft bounce recorded',
        description: res.attemptId
          ? 'The most recent attempt to this address is marked bounced.'
          : 'No earlier attempt to this address was found; the suppression still applies.',
        tone: 'success',
      });
      setEmail('');
      setReason('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record an email bounce or complaint</CardTitle>
        <CardDescription>
          SMTP relays report bounces by email, not by webhook. Record them here: hard bounces and
          complaints suppress the address; a soft bounce only marks the last attempt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="grid gap-4 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error ? (
            <div className="sm:col-span-4">
              <Alert tone="danger" title="Not recorded">
                {error}
              </Alert>
            </div>
          ) : null}
          <Field label="Email address" required>
            {({ id }) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Kind" required>
            {({ id }) => (
              <NativeSelect
                id={id}
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="hard">Hard bounce</option>
                <option value="soft">Soft bounce</option>
                <option value="complaint">Complaint</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="Reason from the bounce message" hint="Optional; stored sanitised.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
            )}
          </Field>
          <Button
            type="submit"
            disabled={!email.trim() || busy}
            loading={busy}
            loadingLabel="Recording"
          >
            Record
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
