'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ProjectDto, ReportDetailDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { OfflineError, syncReportDraft } from '@/lib/partner/offline/sync';
import { newOfflineClientId, type ReportDraft } from '@/lib/partner/offline/types';
import {
  notifyDraftsChanged,
  useDraftStore,
  useOnline,
} from '@/lib/partner/offline/use-draft-store';
import { putBytes } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, NotAvailable, RequestFailed } from '../common';
import { syncStateLabel, syncStateTone } from '../visits/sync-state';

const KINDS = [
  'inspection',
  'progress',
  'snagging',
  'valuation',
  'existing_condition',
  'diligence_memo',
  'search_outcome',
  'other',
] as const;

/** `target`: `new` (+projectId), `report_<offlineId>` (local draft) or a server report id. */
export function ReportEditor({ target, projectId }: { target: string; projectId: string | null }) {
  const p = usePartner();
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const online = useOnline();
  const { store, ready, sealingProblem } = useDraftStore(p.userId);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [locked, setLocked] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'info' | 'danger' | 'warning';
    text: string;
  } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reviewerInput, setReviewerInput] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const isLocal = target.startsWith('report_');
  const isNew = target === 'new';
  const serverReportId = !isLocal && !isNew ? target : null;

  const report = useQuery({
    queryKey: ['partner', 'report', serverReportId],
    queryFn: () => partnerFetch<ReportDetailDto>(`/api/v1/reports/${serverReportId}`),
    enabled: serverReportId !== null,
  });
  const project = useQuery({
    queryKey: ['partner', 'project', draft?.projectId ?? projectId],
    queryFn: () => partnerFetch<ProjectDto>(`/api/v1/projects/${draft?.projectId ?? projectId}`),
    enabled: Boolean(draft?.projectId ?? projectId) && online,
  });
  const reviewer = reviewerInput ?? project.data?.pmUserId ?? '';

  useEffect(() => {
    if (!store || !ready || draft) return;
    let cancelled = false;
    (async () => {
      const nowIso = new Date().toISOString();
      if (isLocal) {
        const found = await store.get(target);
        if (cancelled) return;
        if (!found || found.kind === 'locked') return setLocked(true);
        if (found.kind === 'report') setDraft(found);
        return;
      }
      if (isNew) {
        if (!projectId) return;
        setDraft({
          kind: 'report',
          offlineClientId: newOfflineClientId('report'),
          userId: p.userId,
          projectId,
          reportId: null,
          title: '',
          reportKind: 'inspection',
          summary: '',
          bodyMarkdown: '',
          scopeLimitations: '',
          siteVisitId: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          syncState: 'unsynced',
          serverReportId: null,
          lastSyncAt: null,
          lastSyncError: null,
        });
        return;
      }
      const all = await store.list();
      if (cancelled) return;
      const existing = all.find((d) => d.kind === 'report' && d.reportId === serverReportId);
      if (existing && existing.kind === 'report') return setDraft(existing);
      if (!report.data) return;
      const r = report.data;
      const latest = r.revisions[r.revisions.length - 1];
      if (!r.projectId) return;
      setDraft({
        kind: 'report',
        offlineClientId: newOfflineClientId('report'),
        userId: p.userId,
        projectId: r.projectId,
        reportId: r.id,
        title: r.title,
        reportKind: r.kind,
        summary: latest?.summary ?? '',
        bodyMarkdown: latest?.bodyMarkdown ?? '',
        scopeLimitations: latest?.scopeLimitations ?? '',
        siteVisitId: r.siteVisitId,
        createdAt: nowIso,
        updatedAt: nowIso,
        syncState: 'synced',
        serverReportId: r.id,
        lastSyncAt: null,
        lastSyncError: null,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ready, target, report.data, projectId]);

  useEffect(() => {
    if (!draft || !store || !dirtyRef.current) return;
    setSaveState('saving');
    const t = setTimeout(async () => {
      try {
        await store.put(draft);
        setSaveState('saved');
        notifyDraftsChanged();
      } catch {
        setSaveState('failed');
      }
    }, 500);
    return () => clearTimeout(t);
  }, [draft, store]);

  function update(patch: Partial<ReportDraft>) {
    dirtyRef.current = true;
    setDraft((d) =>
      d ? { ...d, ...patch, updatedAt: new Date().toISOString(), syncState: 'unsynced' } : d,
    );
  }

  async function saveToServer() {
    if (!draft || !store) return;
    if (draft.title.trim().length < 3 || !draft.bodyMarkdown.trim()) {
      setMessage({
        tone: 'warning',
        text: 'A title (3+ characters) and a body are required before saving to the server.',
      });
      return;
    }
    setSyncing(true);
    setMessage(null);
    try {
      await store.put(draft);
      const outcome = await syncReportDraft(draft, {
        api: partnerFetch,
        uploadBytes: putBytes,
        store,
      });
      notifyDraftsChanged();
      void qc.invalidateQueries({ queryKey: ['partner', 'reports'] });
      dirtyRef.current = false;
      if (outcome.cleared && outcome.reportId) {
        toast({ tone: 'success', title: 'Saved on the server', description: outcome.message });
        // The local copy was removed; keep editing against the server report.
        setDraft({ ...outcome.draft, reportId: outcome.reportId, syncState: 'synced' });
        setMessage({ tone: 'success', text: outcome.message });
        void qc.invalidateQueries({ queryKey: ['partner', 'report', outcome.reportId] });
        if (serverReportId !== outcome.reportId) {
          router.replace(`/partner/reports/${outcome.reportId}`);
        }
        return;
      }
      setDraft(outcome.draft);
      setMessage({
        tone: outcome.draft.syncState === 'rejected' ? 'danger' : 'warning',
        text: outcome.message,
      });
    } catch (err) {
      setMessage({
        tone: 'warning',
        text: err instanceof OfflineError ? err.message : errorMessage(err),
      });
    } finally {
      setSyncing(false);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      partnerFetch(`/api/v1/reports/${serverReportId}/submit`, {
        body: { namedReviewerUserId: reviewer.trim(), expectedVersion: report.data?.version },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Submitted for review' });
      void qc.invalidateQueries({ queryKey: ['partner', 'report', serverReportId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'reports'] });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not submit', description: errorMessage(err) }),
  });

  async function discard() {
    if (!draft || !store) return;
    await store.delete(draft.offlineClientId);
    notifyDraftsChanged();
    router.push('/partner/reports');
  }

  if (locked) {
    return (
      <Alert tone="danger" title="Draft cannot be opened">
        It was written in a previous browser session, or no longer exists; the encryption key is
        gone, so it can only be discarded.{' '}
        <Link href="/partner/reports" className="underline">
          Open the reports list to discard it
        </Link>
        .
      </Alert>
    );
  }
  if (isNew && !projectId)
    return (
      <Alert tone="warning" title="Choose a project">
        Start a report from the reports list.
      </Alert>
    );
  if (serverReportId && !draft) {
    if (report.isPending) return <LoadingBlock rows={4} label="Loading report" />;
    if (report.isError)
      return (
        <RequestFailed
          error={report.error}
          onRetry={() => void report.refetch()}
          context="Report"
        />
      );
  }
  if (!ready || !draft) return <LoadingBlock rows={4} label="Preparing editor" />;
  const serverStatus = report.data?.status ?? null;
  const editable =
    !serverStatus || serverStatus === 'draft' || serverStatus === 'changes_requested';
  const localPending = draft.syncState !== 'synced';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/partner/reports" className="underline">
            Reports
          </Link>
        }
        title={draft.title || 'Untitled report'}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {serverStatus ? (
              <StatusBadge status={serverStatus} />
            ) : (
              <Badge tone="neutral">Not on the server yet</Badge>
            )}
            <Badge tone={syncStateTone(draft.syncState)}>
              {localPending ? syncStateLabel(draft.syncState) : 'Matches server'}
            </Badge>
            <span className="text-xs text-fg-muted" role="status" aria-live="polite">
              {saveState === 'saving'
                ? 'Saving on device…'
                : saveState === 'saved'
                  ? 'Saved on device'
                  : saveState === 'failed'
                    ? 'Could not save on device'
                    : ''}
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setDiscardOpen(true)}>
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              Discard local draft
            </Button>
            <Button
              onClick={() => void saveToServer()}
              loading={syncing}
              disabled={!online || !editable || !localPending}
            >
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              {draft.reportId ? 'Save revision to server' : 'Create on server'}
            </Button>
          </>
        }
      />
      {sealingProblem ? (
        <Alert tone="danger" title="Cannot store drafts on this device">
          {sealingProblem}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone={message.tone} title="Server">
          {message.text}
        </Alert>
      ) : null}
      {!editable ? (
        <Alert tone="info" title={`Report is ${humanize(serverStatus ?? '')}`}>
          Only draft and changes-requested reports accept new revisions.
        </Alert>
      ) : null}
      {report.data?.revisions.some((r) => r.reviewNote) ? (
        <Alert tone="warning" title="Reviewer notes">
          {report.data.revisions
            .filter((r) => r.reviewNote)
            .map((r) => `v${r.version}: ${r.reviewNote}`)
            .join(' · ')}
        </Alert>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-3">
          <Field label="Title" htmlFor="report-title" required className="sm:col-span-2">
            {({ id }) => (
              <Input
                id={id}
                value={draft.title}
                maxLength={200}
                disabled={!editable || Boolean(draft.reportId)}
                onChange={(e) => update({ title: e.target.value })}
              />
            )}
          </Field>
          <Field label="Kind" htmlFor="report-kind">
            {({ id }) => (
              <NativeSelect
                id={id}
                value={draft.reportKind}
                disabled={!editable || Boolean(draft.reportId)}
                onChange={(e) => update({ reportKind: e.target.value })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="Summary"
            htmlFor="report-summary"
            className="sm:col-span-3"
            hint="Two or three sentences the customer reads first."
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                className="min-h-20"
                value={draft.summary}
                maxLength={2000}
                disabled={!editable}
                onChange={(e) => update({ summary: e.target.value })}
              />
            )}
          </Field>
          <Field label="Body (Markdown)" htmlFor="report-body" required className="sm:col-span-3">
            {({ id }) => (
              <Textarea
                id={id}
                className="min-h-72 font-mono text-sm"
                value={draft.bodyMarkdown}
                maxLength={500000}
                disabled={!editable}
                onChange={(e) => update({ bodyMarkdown: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Scope limitations"
            htmlFor="report-scope"
            className="sm:col-span-3"
            hint="What you could not inspect, measure or verify."
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                className="min-h-20"
                value={draft.scopeLimitations}
                maxLength={8000}
                disabled={!editable}
                onChange={(e) => update({ scopeLimitations: e.target.value })}
              />
            )}
          </Field>
        </CardContent>
      </Card>
      {report.data ? (
        <Card>
          <CardHeader>
            <CardTitle>Submit for review</CardTitle>
            <p className="text-xs text-fg-muted">
              A named staff reviewer approves the report before release. Save your latest revision
              first.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {report.data.status === 'draft' || report.data.status === 'changes_requested' ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  label="Reviewer user id"
                  htmlFor="report-reviewer"
                  className="sm:col-span-2"
                  hint={
                    project.data?.pmUserId
                      ? 'Pre-filled with the project manager.'
                      : 'No project manager is set; ask staff for the reviewer id.'
                  }
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={reviewer}
                      onChange={(e) => setReviewerInput(e.target.value)}
                    />
                  )}
                </Field>
                <div className="flex items-end">
                  <Button
                    disabled={!reviewer.trim() || localPending || report.data.currentVersion === 0}
                    loading={submit.isPending}
                    onClick={() => submit.mutate()}
                  >
                    Submit for review
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">
                {report.data.namedReviewerName
                  ? `Reviewer: ${report.data.namedReviewerName}. `
                  : ''}
                Status {humanize(report.data.status)}
                {report.data.releasedAt ? (
                  <>
                    {' '}
                    · released <DualTime iso={report.data.releasedAt} zone={p.timeZone} />
                  </>
                ) : null}
              </p>
            )}
            {!project.data?.pmUserId &&
            (report.data.status === 'draft' || report.data.status === 'changes_requested') ? (
              <NotAvailable
                title="Reviewer picker"
                reason="there is no API listing staff reviewers for partners; the id must be supplied by staff."
              />
            ) : null}
            <p className="text-xs text-fg-muted">
              {report.data.revisions.length} revision{report.data.revisions.length === 1 ? '' : 's'}{' '}
              on the server · last{' '}
              {report.data.revisions.length > 0
                ? formatDateTimeLabel(
                    report.data.revisions[report.data.revisions.length - 1]!.createdAt,
                    p.timeZone,
                  )
                : '—'}
            </p>
          </CardContent>
        </Card>
      ) : null}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent
          title="Discard the local draft?"
          description={
            draft.reportId
              ? 'Revisions already saved on the server are kept; only unsaved local changes are lost.'
              : 'This report has never been saved to the server; everything is lost.'
          }
        >
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDiscardOpen(false)}>
              Keep
            </Button>
            <Button variant="danger" onClick={() => void discard()}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
