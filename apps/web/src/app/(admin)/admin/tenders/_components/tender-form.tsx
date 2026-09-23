'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TenderDto } from '@simplexd/contracts';
import { validateEvaluationWeights } from '@simplexd/domain/tenders';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, NativeSelect, Textarea, useToast, type ButtonProps } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { TIMELINE_FIELDS, isoToWallClock, timelineMessages, wallClockToIso } from '../_lib/timeline';

interface Criterion {
  name: string;
  weight: string;
}

/**
 * Create a draft tender or edit a draft. The timeline is validated as you
 * type (each stage after the previous one; release and deadline required) and
 * weights must sum to 100; the server repeats both checks.
 */
export function TenderForm({
  organizations,
  tender,
  trigger = 'New tender',
  variant = 'primary',
}: {
  organizations: Array<{ id: string; name: string }>;
  /** Present when editing a draft. */
  tender?: TenderDto;
  trigger?: string;
  variant?: ButtonProps['variant'];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const zone = tender?.displayTimeZone ?? 'Africa/Lagos';
  const [open, setOpen] = useState(false);
  const [organizationId, setOrganizationId] = useState(tender?.organizationId ?? '');
  const [projectId, setProjectId] = useState(tender?.projectId ?? '');
  const [title, setTitle] = useState(tender?.title ?? '');
  const [description, setDescription] = useState(tender?.descriptionMarkdown ?? '');
  const [disclosure, setDisclosure] = useState(tender?.partnerDisclosure ?? '');
  const [sealed, setSealed] = useState(tender?.sealed ?? true);
  const [times, setTimes] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIMELINE_FIELDS.map((f) => [f.key, isoToWallClock(tender?.timeline.utc[f.key] ?? null, zone)])),
  );
  const [criteria, setCriteria] = useState<Criterion[]>(() =>
    tender
      ? Object.entries(tender.evaluationWeights).map(([name, weight]) => ({ name, weight: String(weight) }))
      : [
          { name: 'price', weight: '50' },
          { name: 'technical', weight: '30' },
          { name: 'schedule', weight: '20' },
        ],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isoTimes = Object.fromEntries(TIMELINE_FIELDS.map((f) => [f.key, wallClockToIso(times[f.key] ?? '', zone)]));
  const timelineProblems = timelineMessages(isoTimes);
  const weights = Object.fromEntries(criteria.map((c) => [c.name.trim(), Number(c.weight)]));
  const weightCheck = validateEvaluationWeights(weights);
  const weightSum = criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const duplicateNames = new Set(criteria.map((c) => c.name.trim())).size !== criteria.length;
  const valid = Boolean(organizationId) && title.trim().length >= 3 && timelineProblems.length === 0 && weightCheck.ok && !duplicateNames;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const timeline = {
        releaseAt: isoTimes.releaseAt,
        siteVisitAt: isoTimes.siteVisitAt,
        questionCutoffAt: isoTimes.questionCutoffAt,
        answersPublishedAt: isoTimes.answersPublishedAt,
        submissionDeadlineAt: isoTimes.submissionDeadlineAt,
        evaluationCompleteAt: isoTimes.evaluationCompleteAt,
        awardTargetAt: isoTimes.awardTargetAt,
      };
      const common = {
        title: title.trim(),
        descriptionMarkdown: description.trim() || null,
        projectId: projectId.trim() || null,
        timeline,
        displayTimeZone: zone,
        evaluationWeights: weights,
        partnerDisclosure: disclosure.trim() || null,
        sealed,
      };
      const result = tender
        ? await adminFetch<TenderDto>(`/api/v1/tenders/${tender.id}`, { method: 'PATCH', body: { ...common, expectedVersion: tender.version } })
        : await adminFetch<TenderDto>('/api/v1/tenders', { body: { ...common, organizationId, scopeFileIds: [] } });
      toast({ title: tender ? 'Draft updated' : `Draft ${result.reference} created`, tone: 'success' });
      setOpen(false);
      if (!tender) router.push(`/admin/tenders/${result.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} size={tender ? 'sm' : 'md'} onClick={() => setOpen(true)}>
        {trigger}
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent title={tender ? `Edit draft ${tender.reference}` : 'New tender (draft)'} description="Drafts are invisible to partners until published. After publication, changes are revisions with a reason." size="lg">
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Not saved">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer organisation" required>
                {({ id }) => (
                  <NativeSelect id={id} value={organizationId} disabled={Boolean(tender)} onChange={(e) => setOrganizationId(e.target.value)}>
                    <option value="">Choose</option>
                    {organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Project id (optional)" hint="Links the tender to a project of the same organisation.">
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={projectId} onChange={(e) => setProjectId(e.target.value)} />}
              </Field>
              <div className="sm:col-span-2">
                <Field label="Title" required>
                  {({ id }) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Scope (markdown)">
                  {({ id }) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-24" />}
                </Field>
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Timeline ({zone})</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {TIMELINE_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} required={f.required}>
                    {({ id }) => <Input id={id} type="datetime-local" value={times[f.key] ?? ''} onChange={(e) => setTimes((prev) => ({ ...prev, [f.key]: e.target.value }))} />}
                  </Field>
                ))}
              </div>
              {timelineProblems.length > 0 ? (
                <Alert tone="warning" title="Timeline needs attention">
                  <ul className="list-disc pl-4">
                    {timelineProblems.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </Alert>
              ) : (
                <p className="text-xs text-success">Timeline is in order.</p>
              )}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Evaluation criteria (weights sum to 100)</legend>
              {criteria.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                  <Field label={`Criterion ${i + 1}`}>
                    {({ id }) => <Input id={id} value={c.name} maxLength={64} onChange={(e) => setCriteria((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />}
                  </Field>
                  <Field label="Weight">
                    {({ id }) => <Input id={id} inputMode="decimal" value={c.weight} onChange={(e) => setCriteria((prev) => prev.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))} />}
                  </Field>
                  <Button variant="ghost" size="sm" aria-label={`Remove criterion ${i + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((prev) => prev.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setCriteria((prev) => [...prev, { name: '', weight: '' }])}>
                  <Plus aria-hidden="true" className="h-4 w-4" /> Add criterion
                </Button>
                <span className={weightCheck.ok && !duplicateNames ? 'text-xs text-success' : 'text-xs text-warning'} aria-live="polite">
                  Sum {weightSum}
                  {duplicateNames ? ' · criterion names must be unique' : weightCheck.ok ? ' · valid' : ` · ${weightCheck.violations[0]?.message ?? ''}`}
                </span>
              </div>
            </fieldset>
            <Field label="Disclosed partner relationships" hint="Shown to every invitee. Leave blank only when there is nothing to disclose.">
              {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={disclosure} onChange={(e) => setDisclosure(e.target.value)} className="min-h-16" />}
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
              Sealed bids (contents hidden from everyone until opened after closing, with a recorded reason)
            </label>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
                {tender ? 'Save draft' : 'Create draft'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
