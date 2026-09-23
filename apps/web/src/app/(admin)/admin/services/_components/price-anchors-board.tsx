'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatDateLabel,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import type { AnchorValues } from '@/lib/services/price-anchors';
import { basisLabel, priceAnchorLabel, priceStatusLabel } from '@/components/public/price-anchor';
import type { PriceAnchorDto } from '@/server/admin/configuration/pricing';
import type { ServiceOption } from '@/server/admin/configuration/shared';
import { ActionDialog } from '../../_components/action-dialog';
import { fmtDate } from '../../_components/bits';
import { AnchorForm, formFromValues, payloadFromForm, type AnchorFormState } from './anchor-form';

/** Human summary of an anchor's figure regardless of publication state. */
export function figureLabel(v: AnchorValues): string {
  return (
    priceAnchorLabel({
      priceBasis: v.priceBasis,
      amountKobo: v.amountKobo,
      percentageBps: v.percentageBps,
      publicationState: 'published',
    }) ?? 'Not set'
  );
}

export function ValuesSummary({ v }: { v: AnchorValues }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-fg-muted">Figure</dt>
      <dd className="font-medium">{figureLabel(v)}</dd>
      <dt className="text-fg-muted">Basis</dt>
      <dd>{basisLabel(v.priceBasis)}</dd>
      <dt className="text-fg-muted">Minimum scope</dt>
      <dd>{v.minimumScope ?? '—'}</dd>
      <dt className="text-fg-muted">Exclusions</dt>
      <dd>{v.exclusions ?? '—'}</dd>
      <dt className="text-fg-muted">Effective</dt>
      <dd>
        {v.effectiveFrom ? `from ${formatDateLabel(v.effectiveFrom)}` : 'not set'}
        {v.effectiveTo ? ` to ${formatDateLabel(v.effectiveTo)}` : ''}
      </dd>
    </dl>
  );
}

type Action = 'submit' | 'publish' | 'reject' | 'withdraw';

const ACTION_COPY: Record<Action, { title: string; confirm: string; tone: 'primary' | 'danger'; description: string }> = {
  submit: {
    title: 'Submit for business review',
    confirm: 'Submit',
    tone: 'primary',
    description: 'A different pricing manager must publish it. Nothing changes publicly until then.',
  },
  publish: {
    title: 'Publish this anchor',
    confirm: 'Publish',
    tone: 'primary',
    description:
      'Replaces the live anchor on the public site from its effective date and records a published revision.',
  },
  reject: {
    title: 'Reject this proposal',
    confirm: 'Reject',
    tone: 'danger',
    description: 'The live anchor stays as it is; the proposal is kept in history with your reason.',
  },
  withdraw: {
    title: 'Withdraw this proposal',
    confirm: 'Withdraw',
    tone: 'danger',
    description: 'Removes the proposal from review; history is kept.',
  },
};

export function PriceAnchorsBoard({
  items,
  services,
  canManage,
  mfaVerified,
  userId,
  today,
}: {
  items: PriceAnchorDto[];
  services: ServiceOption[];
  canManage: boolean;
  mfaVerified: boolean;
  userId: string;
  today: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<PriceAnchorDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AnchorFormState>(() => formFromValues(null, today));
  const [note, setNote] = useState('');
  const [newServiceId, setNewServiceId] = useState(services[0]?.id ?? '');
  const [newSlug, setNewSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ item: PriceAnchorDto; action: Action } | null>(null);
  const [retiring, setRetiring] = useState<PriceAnchorDto | null>(null);

  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  function openEdit(item: PriceAnchorDto) {
    setForm(formFromValues(item.proposal?.values ?? item.live, today));
    setNote('');
    setError(null);
    setEditing(item);
  }

  function openCreate() {
    setForm(formFromValues(null, today));
    setNote('');
    setNewSlug('standard');
    setError(null);
    setCreating(true);
  }

  async function saveDraft() {
    const payload = payloadFromForm(form);
    if (!payload.values) {
      setError(payload.error ?? 'Check the form.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await adminFetch('/api/v1/admin/price-anchors', {
          body: { serviceId: newServiceId, slug: newSlug.trim(), values: payload.values, note: note || undefined },
        });
        toast({ title: 'Package created as a draft proposal', tone: 'success' });
        setCreating(false);
      } else if (editing) {
        await adminFetch(`/api/v1/admin/price-anchors/${editing.id}/draft`, {
          body: { values: payload.values, expectedRevision: editing.latestRevision, note: note || undefined },
        });
        toast({ title: 'Draft saved as a new revision', tone: 'success' });
        setEditing(null);
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTransition(reason: string) {
    if (!pending) return;
    await adminFetch(`/api/v1/admin/price-anchors/${pending.item.id}/transition`, {
      body: { action: pending.action, expectedRevision: pending.item.latestRevision, reason },
    });
    toast({ title: `${ACTION_COPY[pending.action].confirm}: ${pending.item.live.name}`, tone: 'success' });
    router.refresh();
  }

  async function runRetire(reason: string) {
    if (!retiring) return;
    await adminFetch(`/api/v1/admin/price-anchors/${retiring.id}/retire`, {
      body: { expectedVersion: retiring.version, reason },
    });
    toast({ title: `Retired ${retiring.live.name}`, tone: 'success' });
    router.refresh();
  }

  const byService = new Map<string, PriceAnchorDto[]>();
  for (const it of items) {
    const list = byService.get(it.serviceId) ?? [];
    list.push(it);
    byService.set(it.serviceId, list);
  }
  const groups = services
    .map((s) => ({ service: s, anchors: byService.get(s.id) ?? [] }))
    .filter((g) => g.anchors.length > 0 || g.service.category === 'core');

  return (
    <div className="space-y-6">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={openCreate} disabled={services.length === 0}>
            Add package
          </Button>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-fg-muted">
          No services are configured yet; run the reference seed first.
        </p>
      ) : null}
      {groups.map(({ service, anchors }) => (
        <section key={service.id} aria-labelledby={`svc-${service.id}`} className="space-y-3">
          <h2 id={`svc-${service.id}`} className="text-lg font-semibold">
            {service.name}{' '}
            <Link href={`/services/${service.slug}`} className="text-sm font-normal text-primary underline">
              public page
            </Link>
          </h2>
          {anchors.length === 0 ? (
            <p className="text-sm text-fg-muted">No package yet; the public page says pricing is by quotation.</p>
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2">
              {anchors.map((a) => {
                const p = a.proposal;
                const isAuthor = p?.authors.some((u) => u.id === userId) ?? false;
                return (
                  <li key={a.id} className="rounded-lg border border-border bg-bg-elevated p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {a.live.name} <span className="font-mono text-xs text-fg-muted">{a.slug}</span>
                        </p>
                        <StatusBadge status={a.publicationState} label={priceStatusLabel(a.publicationState)} />
                      </div>
                      <Link href={`/admin/services/pricing/${a.id}`} className="text-sm text-primary underline">
                        History ({a.latestRevision} revision{a.latestRevision === 1 ? '' : 's'})
                      </Link>
                    </div>
                    <div className="mt-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                        {a.publicationState === 'published' ? 'Live on the public site' : 'Stored values (not public)'}
                      </p>
                      <ValuesSummary v={a.live} />
                      {a.publishedAt ? (
                        <p className="mt-1 text-xs text-fg-muted">
                          Published {fmtDate(a.publishedAt)}
                          {a.reviewedBy ? ` by ${a.reviewedBy.name}` : ''}.
                        </p>
                      ) : null}
                    </div>
                    {p ? (
                      <div className="mt-3 rounded-md border border-warning/50 bg-warning-soft/30 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={p.state === 'in_review' ? 'warning' : 'neutral'}>
                            {p.state === 'in_review' ? 'Proposal under review' : 'Draft proposal'}
                          </Badge>
                          {p.implicit ? (
                            <span className="text-xs text-fg-muted">Seeded anchor awaiting first business review</span>
                          ) : (
                            <span className="text-xs text-fg-muted">
                              by {p.authors.map((u) => u.name).join(', ') || 'unknown'} · updated{' '}
                              {fmtDate(p.updatedAt)}
                            </span>
                          )}
                        </div>
                        {!p.implicit ? (
                          <div className="mt-2">
                            <ValuesSummary v={p.values} />
                          </div>
                        ) : null}
                        {canManage ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {p.state === 'draft' ? (
                              <>
                                <Button size="sm" variant="secondary" onClick={() => openEdit(a)}>
                                  Edit draft
                                </Button>
                                <Button size="sm" onClick={() => setPending({ item: a, action: 'submit' })}>
                                  Submit for review
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => setPending({ item: a, action: 'publish' })}
                                  disabled={isAuthor || !mfaVerified}
                                  title={
                                    isAuthor
                                      ? 'You drafted or submitted this proposal; a different pricing manager must publish it.'
                                      : !mfaVerified
                                        ? 'Publishing needs a verified authenticator.'
                                        : undefined
                                  }
                                >
                                  Publish
                                </Button>
                                {!isAuthor ? (
                                  <Button size="sm" variant="secondary" onClick={() => setPending({ item: a, action: 'reject' })}>
                                    Reject
                                  </Button>
                                ) : null}
                                {!p.implicit ? (
                                  <Button size="sm" variant="ghost" onClick={() => openEdit(a)}>
                                    Revise
                                  </Button>
                                ) : null}
                              </>
                            )}
                            {!p.implicit ? (
                              <Button size="sm" variant="ghost" onClick={() => setPending({ item: a, action: 'withdraw' })}>
                                Withdraw
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        {canManage && p.state === 'in_review' && isAuthor ? (
                          <p className="mt-2 text-xs text-fg-muted">
                            You are an author of this proposal, so someone else must publish or reject it.
                          </p>
                        ) : null}
                        {canManage && p.state === 'in_review' && !isAuthor && !mfaVerified ? (
                          <p className="mt-2 text-xs text-fg-muted">
                            <Link href="/admin/security/mfa?required=1" className="underline">
                              Verify your authenticator
                            </Link>{' '}
                            to publish or retire anchors.
                          </p>
                        ) : null}
                      </div>
                    ) : canManage ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => openEdit(a)}>
                          Propose a change
                        </Button>
                        {a.publicationState !== 'retired' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRetiring(a)}
                            disabled={!mfaVerified}
                            title={!mfaVerified ? 'Retiring needs a verified authenticator.' : undefined}
                          >
                            Retire
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}

      <Dialog open={creating || editing !== null} onOpenChange={(v) => !busy && !v && closeForm()}>
        <DialogContent
          className={DIALOG_MAX_H}
          size="lg"
          title={creating ? 'Add a package' : `Propose a change to ${editing?.live.name ?? ''}`}
          description={
            creating
              ? 'The package starts as a draft proposal; it is not shown publicly until a different pricing manager publishes it.'
              : 'Saved as a new revision. The live anchor does not change until the proposal is reviewed and published by someone else.'
          }
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            {creating ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Service" required>
                  {({ id }) => (
                    <NativeSelect id={id} value={newServiceId} onChange={(e) => setNewServiceId(e.target.value)}>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.category === 'expansion' ? ' (planned)' : ''}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field label="Package slug" required hint="Lowercase, unique within the service, e.g. standard.">
                  {({ id }) => <Input id={id} value={newSlug} onChange={(e) => setNewSlug(e.target.value)} />}
                </Field>
              </div>
            ) : null}
            <AnchorForm value={form} onChange={setForm} />
            <Field label="Note for reviewers (optional)">
              {({ id }) => (
                <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-14" maxLength={500} />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={closeForm} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} onClick={() => void saveDraft()}>
                {creating ? 'Create draft' : 'Save draft revision'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ActionDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? ACTION_COPY[pending.action].title : ''}
        description={pending ? ACTION_COPY[pending.action].description : undefined}
        confirmLabel={pending ? ACTION_COPY[pending.action].confirm : 'Confirm'}
        tone={pending ? ACTION_COPY[pending.action].tone : 'primary'}
        requireReason
        onConfirm={runTransition}
      >
        {pending?.action === 'publish' && pending.item.proposal ? (
          <div className="rounded-md bg-bg-sunken p-3">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Going live</p>
            <ValuesSummary v={pending.item.proposal.values} />
            <p className="mt-2 text-xs text-fg-muted">
              Now: {figureLabel(pending.item.live)} ({priceStatusLabel(pending.item.publicationState)})
            </p>
          </div>
        ) : null}
      </ActionDialog>

      <ActionDialog
        open={retiring !== null}
        onOpenChange={(o) => !o && setRetiring(null)}
        title={`Retire ${retiring?.live.name ?? ''}`}
        description="The package disappears from the public site. History is kept and a later proposal can publish it again."
        confirmLabel="Retire"
        tone="danger"
        requireReason
        onConfirm={runRetire}
      />
    </div>
  );
}
