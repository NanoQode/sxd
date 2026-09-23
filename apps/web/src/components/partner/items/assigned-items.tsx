'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import type { EngagementItemDto, Page } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { openSignedDownload, uploadFile } from '@/lib/partner/upload';
import {
  ItemHeading,
  ItemMeta,
  ItemResponses,
  SEVERITY_LABELS,
} from '@/components/engagements/item-view';
import { LoadingBlock, RequestFailed } from '../common';

/**
 * Items assigned to the signed-in partner (legal, survey, inspection):
 * record the reference and findings, attach evidence they upload themselves,
 * move the status (in progress, satisfied, failed with a reason) and reply.
 * Only the partner's own and granted evidence is listed; the server hides
 * everything else on the request.
 */

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

function transitionLabel(to: string): string {
  switch (to) {
    case 'in_progress':
      return 'Start';
    case 'open':
      return 'Back to open';
    case 'satisfied':
      return 'Mark satisfied';
    case 'failed':
      return 'Mark failed';
    default:
      return humanize(to);
  }
}

function ItemCard({ item, zone }: { item: EngagementItemDto; zone: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    detail: item.detail ?? '',
    reference: item.reference ?? '',
    severity: item.severity ?? '',
  });
  const [transition, setTransition] = useState<{ to: string; reasonRequired: boolean } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const [reply, setReply] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['partner', 'items'] });

  const update = useMutation({
    mutationFn: () =>
      partnerFetch<EngagementItemDto>(`/api/v1/engagement-items/${item.id}`, {
        method: 'PATCH',
        body: {
          ...(item.can.editableFields.includes('detail') ? { detail: form.detail.trim() || null } : {}),
          ...(item.can.editableFields.includes('reference')
            ? { reference: form.reference.trim() || null }
            : {}),
          ...(item.can.editableFields.includes('severity') ? { severity: form.severity || null } : {}),
          expectedVersion: item.version,
        },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Item updated' });
      setEditing(false);
      void invalidate();
    },
  });
  const move = useMutation({
    mutationFn: (input: { to: string; reason?: string }) =>
      partnerFetch<EngagementItemDto>(`/api/v1/engagement-items/${item.id}/transition`, {
        body: {
          to: input.to,
          reason: input.reason || undefined,
          resolutionNote: input.reason || undefined,
          expectedVersion: item.version,
        },
      }),
    onSuccess: (updated) => {
      toast({ tone: 'success', title: `Item ${humanize(updated.status).toLowerCase()}` });
      setTransition(null);
      setReason('');
      void invalidate();
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not update the status', description: errorMessage(err) }),
  });
  const respond = useMutation({
    mutationFn: () =>
      partnerFetch<EngagementItemDto>(`/api/v1/engagement-items/${item.id}/responses`, {
        body: { body: reply.trim(), expectedVersion: item.version },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Reply added' });
      setReply('');
      void invalidate();
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not reply', description: errorMessage(err) }),
  });

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const ids: string[] = [];
      for (const file of Array.from(files)) {
        const result = await uploadFile(file, {
          purpose: 'evidence',
          entityType: 'service_request',
          entityId: item.serviceRequestId,
        });
        if (result.outcome === 'rejected') {
          toast({
            tone: 'danger',
            title: `${file.name} was rejected`,
            description: result.file.statusReason ?? 'Content inspection refused the file.',
          });
          continue;
        }
        ids.push(result.file.id);
      }
      if (ids.length > 0) {
        await partnerFetch(`/api/v1/engagement-items/${item.id}/evidence`, {
          body: { fileIds: ids, expectedVersion: item.version },
        });
        toast({ tone: 'success', title: `${ids.length} file(s) attached` });
        void invalidate();
      }
    } catch (err) {
      toast({ tone: 'danger', title: 'Upload failed', description: errorMessage(err) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const severityRequired = item.kind === 'red_flag' || item.kind === 'site_finding';
  return (
    <li>
      <Card className="h-full">
        <CardHeader className="space-y-1">
          <ItemHeading item={item} />
          <p className="text-xs text-fg-muted">
            {item.serviceRequestReference ?? 'Request'}
            {item.serviceRequestTitle ? ` · ${item.serviceRequestTitle}` : ''}
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ItemMeta item={item} zone={zone} />
          <ItemResponses item={item} zone={zone} />
          <div>
            <p className="text-xs font-medium text-fg-muted">Your evidence</p>
            {item.evidence.length === 0 ? (
              <p className="text-xs text-fg-muted">Nothing attached yet.</p>
            ) : (
              <ul className="space-y-1">
                {item.evidence.map((e) => (
                  <li key={e.fileId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all">{e.originalName}</span>
                    <Button
                      size="sm"
                      variant="link"
                      disabled={e.status !== 'clean'}
                      onClick={() => void openSignedDownload(e.fileId)}
                    >
                      {e.status === 'clean' ? 'Open' : humanize(e.status)}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {item.can.editableFields.length > 0 ||
          item.can.transitions.length > 0 ||
          item.can.attachEvidence ||
          item.can.respond ? (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {item.can.editableFields.length > 0 ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Record findings
                </Button>
              ) : null}
              {item.can.transitions.map((t) => (
                <Button
                  key={t.to}
                  size="sm"
                  variant={t.to === 'satisfied' ? 'primary' : 'secondary'}
                  loading={move.isPending && move.variables?.to === t.to}
                  onClick={() => (t.reasonRequired ? setTransition(t) : move.mutate({ to: t.to }))}
                >
                  {transitionLabel(t.to)}
                </Button>
              ))}
              {item.can.attachEvidence ? (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="sr-only"
                    aria-label={`Upload evidence for ${item.title}`}
                    onChange={(e) => void upload(e.target.files)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={uploading}
                    onClick={() => fileInput.current?.click()}
                  >
                    Upload evidence
                  </Button>
                </>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-fg-muted">
              This item is {humanize(item.status).toLowerCase()}; no action is open to you.
            </p>
          )}
          {item.can.respond ? (
            <Field label="Reply" hint="Visible to staff and, when the item is shared, the customer.">
              {({ id, describedBy }) => (
                <div className="space-y-2">
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={2}
                    maxLength={4000}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={reply.trim().length === 0}
                    loading={respond.isPending}
                    onClick={() => respond.mutate()}
                  >
                    Send reply
                  </Button>
                </div>
              )}
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={editing} onOpenChange={(o) => (!update.isPending ? setEditing(o) : undefined)}>
        <DialogContent
          title={`Record findings: ${item.title}`}
          description="Your reference, findings and severity are recorded with your name; staff decide the final status of items you cannot close yourself."
        >
          <div className="space-y-3">
            {update.isError ? (
              <Alert tone="danger" title="Could not save">
                {errorMessage(update.error)}
              </Alert>
            ) : null}
            {item.can.editableFields.includes('reference') ? (
              <Field label="Reference" hint="Survey plan, registry entry or instrument number.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={form.reference}
                    maxLength={300}
                    onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
                  />
                )}
              </Field>
            ) : null}
            {item.can.editableFields.includes('detail') ? (
              <Field label="Findings">
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={4}
                    maxLength={8000}
                    value={form.detail}
                    onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))}
                  />
                )}
              </Field>
            ) : null}
            {item.can.editableFields.includes('severity') ? (
              <Field label="Severity" required={severityRequired}>
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={form.severity}
                    onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                  >
                    <option value="">{severityRequired ? 'Choose…' : 'None'}</option>
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {SEVERITY_LABELS[s]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button
              loading={update.isPending}
              disabled={severityRequired && !form.severity}
              onClick={() => update.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transition !== null} onOpenChange={(o) => (!o ? setTransition(null) : undefined)}>
        {transition ? (
          <DialogContent
            title={`${transitionLabel(transition.to)}?`}
            description="The reason is recorded with the item and shown to staff."
          >
            <Field label="Reason" required>
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setTransition(null)}>
                Keep as is
              </Button>
              <Button
                variant={transition.to === 'failed' ? 'danger' : 'primary'}
                disabled={reason.trim().length === 0}
                loading={move.isPending}
                onClick={() => move.mutate({ to: transition.to, reason: reason.trim() })}
              >
                {transitionLabel(transition.to)}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </li>
  );
}

export function AssignedItems() {
  const p = usePartner();
  const params = useSearchParams();
  const serviceRequestId = params.get('serviceRequestId') ?? undefined;
  const [openOnly, setOpenOnly] = useState(true);
  const list = useQuery({
    queryKey: ['partner', 'items', serviceRequestId ?? 'all', openOnly],
    queryFn: () =>
      partnerFetch<Page<EngagementItemDto>>(
        withQuery('/api/v1/engagement-items/mine', {
          serviceRequestId,
          openOnly: openOnly ? undefined : 'false',
          limit: 100,
        }),
      ),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Assigned items"
        description="Checklist items, survey references and findings assigned to you on the requests you work on. You see only your items and the evidence shared with you."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Show</span>
            <NativeSelect
              aria-label="Filter items"
              value={openOnly ? 'open' : 'all'}
              onChange={(e) => setOpenOnly(e.target.value === 'open')}
            >
              <option value="open">Open only</option>
              <option value="all">All</option>
            </NativeSelect>
          </label>
        }
      />
      {serviceRequestId ? (
        <Badge tone="info">Filtered to one request</Badge>
      ) : null}
      {list.isPending ? (
        <LoadingBlock label="Loading items" />
      ) : list.isError ? (
        <RequestFailed error={list.error} onRetry={() => void list.refetch()} context="Assigned items" />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title="No assigned items"
          description={
            openOnly
              ? 'Nothing is open for you right now. Staff assign checklist items, survey references and findings from the request; you are notified when they do.'
              : 'No items have been assigned to you on this request.'
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.data.items.map((item) => (
            <ItemCard key={item.id} item={item} zone={p.timeZone} />
          ))}
        </ul>
      )}
    </div>
  );
}
