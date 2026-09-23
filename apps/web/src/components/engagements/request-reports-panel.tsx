'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReportDto, ReportTemplateOutlineDto } from '@simplexd/contracts';
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
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/**
 * Reports linked to a request and the dialog that drafts a decision
 * memorandum or virtual inspection report from the active template of the
 * kind. The dialog shows the template's sections and guidance so the author
 * knows what the reviewer expects before the draft is created.
 */

type Kind = 'diligence_memo' | 'virtual_inspection';

const KIND_LABEL: Record<Kind, string> = {
  diligence_memo: 'Decision memorandum',
  virtual_inspection: 'Virtual inspection report',
};

function defaultKind(workflowTemplateKey: string): Kind {
  return workflowTemplateKey === 'virtual_inspection' ? 'virtual_inspection' : 'diligence_memo';
}

function DraftDialog({
  serviceRequestId,
  workflowTemplateKey,
  requestTitle,
  open,
  onOpenChange,
}: {
  serviceRequestId: string;
  workflowTemplateKey: string;
  requestTitle: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState<Kind>(defaultKind(workflowTemplateKey));
  const [title, setTitle] = useState(
    `${requestTitle} — ${KIND_LABEL[defaultKind(workflowTemplateKey)].toLowerCase()}`,
  );
  const [referenceItems, setReferenceItems] = useState(true);
  // The outline is keyed by the kind it was loaded for, so switching kind shows
  // "loading" until the matching response arrives (no state reset in the effect).
  const [loaded, setLoaded] = useState<{
    kind: Kind;
    outline: ReportTemplateOutlineDto | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outline = loaded?.kind === kind ? loaded.outline : null;
  const outlineError = loaded?.kind === kind ? loaded.error : null;

  useEffect(() => {
    let cancelled = false;
    adminFetch<ReportTemplateOutlineDto>(`/api/v1/report-templates/outline?kind=${kind}`)
      .then((o) => {
        if (!cancelled) setLoaded({ kind, outline: o, error: null });
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ kind, outline: null, error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const report = await adminFetch<ReportDto>(
        `/api/v1/service-requests/${serviceRequestId}/reports`,
        {
          body: {
            kind,
            title: title.trim(),
            referenceItems,
            ...(outline?.id ? { templateId: outline.id } : {}),
          },
        },
      );
      toast({
        title: 'Draft created',
        description: 'Fill the sections, then submit for review.',
        tone: 'success',
      });
      onOpenChange(false);
      router.push(`/admin/reports/${report.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent
        title="Draft a report under this request"
        description="The draft starts from the active template of the kind: one section per heading, the standard scope and limitations wording, and a snapshot of the customer-visible records. Release needs a named reviewer who is not the author."
        size="lg"
      >
        <div className="space-y-3 overflow-y-auto">
          {error ? (
            <Alert tone="danger" title="Could not create the draft">
              {error}
            </Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={kind}
                  onChange={(e) => {
                    const k = e.target.value as Kind;
                    setKind(k);
                    setTitle(`${requestTitle} — ${KIND_LABEL[k].toLowerCase()}`);
                  }}
                >
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Title" required className="sm:col-span-2">
              {({ id }) => (
                <Input
                  id={id}
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={referenceItems}
                onChange={(e) => setReferenceItems(e.target.checked)}
              />
              Include a snapshot of the customer-visible records (red flags, findings, checklist
              status, evidence references) with every revision
            </label>
          </div>
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">Template</p>
            {outlineError ? (
              <p className="text-danger">{outlineError}</p>
            ) : !outline ? (
              <p className="text-fg-muted">Loading the active template…</p>
            ) : (
              <>
                <p className="text-xs text-fg-muted">
                  {outline.name}
                  {outline.version ? ` · v${outline.version}` : ''}
                  {!outline.id
                    ? ' · no active template of this kind; a built-in outline is used'
                    : ''}
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  {outline.sections.map((s) => (
                    <li key={s.key}>
                      <span className="font-medium">{s.heading}</span>
                      {s.required ? (
                        <Badge tone="warning" className="ml-1">
                          required
                        </Badge>
                      ) : null}
                      {s.guidance ? (
                        <span className="block text-xs text-fg-muted">{s.guidance}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {outline.limitationsMarkdown ? (
                  <p className="mt-2 text-xs text-fg-muted">
                    Standard scope and limitations: {outline.limitationsMarkdown}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    The template carries no standard limitations wording; write the scope and
                    limitations before submitting.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={title.trim().length < 3}>
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RequestReportsPanel({
  serviceRequestId,
  workflowTemplateKey,
  requestTitle,
  reports,
  canDraft,
  requestClosed,
}: {
  serviceRequestId: string;
  workflowTemplateKey: string;
  requestTitle: string;
  reports: ReportDto[];
  canDraft: boolean;
  requestClosed: boolean;
}) {
  const [drafting, setDrafting] = useState(false);
  return (
    <div className="space-y-3">
      {reports.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No report on this request yet. The decision memorandum (due diligence) or inspection
          report is drafted here, reviewed by a named professional and released to the customer.
        </p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
            >
              <span className="min-w-0">
                <Link href={`/admin/reports/${r.id}`} className="font-medium underline">
                  {r.title}
                </Link>
                <span className="block text-xs text-fg-muted">
                  {humanize(r.kind)} · v{r.currentVersion}
                  {r.releasedVersion ? ` · released v${r.releasedVersion}` : ''}
                  {r.releasedAt ? ` ${formatDateTimeLabel(r.releasedAt)}` : ''}
                  {r.authorName ? ` · author ${r.authorName}` : ''}
                  {r.namedReviewerName ? ` · reviewer ${r.namedReviewerName}` : ''}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge
                  status={r.status === 'released' ? 'delivered' : r.status}
                  label={humanize(r.status)}
                />
                {r.releasedVersion ? (
                  <a
                    href={`/api/v1/reports/${r.id}/export`}
                    target="_blank"
                    rel="noopener"
                    className="text-sm underline"
                  >
                    Export
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canDraft && !requestClosed ? (
        <Button size="sm" onClick={() => setDrafting(true)}>
          Draft report
        </Button>
      ) : (
        <p className="text-xs text-fg-muted">
          {requestClosed
            ? 'The request is closed; no new reports can be drafted.'
            : 'Drafting needs reports.draft on this request (project managers and inspectors attached to it).'}
        </p>
      )}
      {drafting ? (
        <DraftDialog
          serviceRequestId={serviceRequestId}
          workflowTemplateKey={workflowTemplateKey}
          requestTitle={requestTitle}
          open={drafting}
          onOpenChange={setDrafting}
        />
      ) : null}
    </div>
  );
}
