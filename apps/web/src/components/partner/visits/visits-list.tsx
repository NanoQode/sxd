'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { Lock, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { Page, ProjectDto, SiteVisitDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  PageHeader,
  StatusBadge,
  humanize,
  useToast,
  formatDateTimeLabel,
} from '@simplexd/ui';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { OfflineError, syncVisitDraft } from '@/lib/partner/offline/sync';
import type { Draft, LockedDraft, VisitDraft } from '@/lib/partner/offline/types';
import { notifyDraftsChanged, useDrafts, useOnline } from '@/lib/partner/offline/use-draft-store';
import { putBytes } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, RequestFailed } from '../common';

export function syncStateTone(
  state: Draft['syncState'],
): 'warning' | 'danger' | 'success' | 'info' {
  switch (state) {
    case 'synced':
      return 'success';
    case 'rejected':
      return 'danger';
    case 'syncing':
      return 'info';
    default:
      return 'warning';
  }
}

export function syncStateLabel(state: Draft['syncState']): string {
  switch (state) {
    case 'unsynced':
      return 'Unsynced';
    case 'syncing':
      return 'Syncing…';
    case 'partial':
      return 'Partly synced';
    case 'synced':
      return 'Synced';
    case 'rejected':
      return 'Rejected by server';
  }
}

function LocalDrafts({ userId }: { userId: string }) {
  const { drafts, loading, store, sealingProblem, persistent, refresh } = useDrafts(userId);
  const online = useOnline();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<Draft | LockedDraft | null>(null);
  const visits = drafts.filter(
    (d): d is VisitDraft | LockedDraft =>
      d.kind === 'visit' || (d.kind === 'locked' && d.draftKind === 'visit'),
  );

  async function sync(d: VisitDraft) {
    if (!store) return;
    setBusy(d.offlineClientId);
    try {
      const outcome = await syncVisitDraft(d, { api: partnerFetch, uploadBytes: putBytes, store });
      toast({
        tone: outcome.cleared ? 'success' : outcome.visitOutcome === 'rejected' ? 'danger' : 'info',
        title: outcome.cleared ? 'Synced' : 'Sync incomplete',
        description: outcome.message,
      });
    } catch (err) {
      toast({
        tone: 'danger',
        title: err instanceof OfflineError ? 'Offline' : 'Sync failed',
        description: err instanceof Error ? err.message : 'unknown error',
      });
    } finally {
      setBusy(null);
      notifyDraftsChanged();
      refresh();
    }
  }

  async function discard() {
    if (!store || !discarding) return;
    await store.delete(discarding.offlineClientId);
    setDiscarding(null);
    notifyDraftsChanged();
    refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Drafts on this device</CardTitle>
          <p className="text-xs text-fg-muted">
            Encrypted with a key that lives only in this browser session. Cleared only after the
            server confirms.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={
            !online ||
            busy !== null ||
            visits.every((d) => d.kind === 'locked' || d.syncState === 'synced')
          }
          onClick={async () => {
            for (const d of visits)
              if (d.kind === 'visit' && d.syncState !== 'synced') await sync(d);
          }}
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Sync all
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {sealingProblem ? (
          <Alert tone="warning" title="Drafts cannot be stored on this device">
            {sealingProblem}
          </Alert>
        ) : null}
        {!persistent ? (
          <Alert tone="warning" title="Drafts live only while this page is open">
            IndexedDB is unavailable (private window or blocked storage); nothing survives a reload.
          </Alert>
        ) : null}
        {!online ? (
          <Alert tone="warning" title="Offline">
            You can keep capturing. Sync becomes available when the connection returns.
          </Alert>
        ) : null}
        {loading ? (
          <LoadingBlock rows={1} label="Reading drafts" />
        ) : visits.length === 0 ? (
          <p className="text-sm text-fg-muted">No drafts on this device.</p>
        ) : (
          <ul className="space-y-2">
            {visits.map((d) => (
              <li
                key={d.offlineClientId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {d.kind === 'locked' ? <Lock aria-hidden="true" className="h-4 w-4" /> : null}
                    {d.title}
                    <Badge tone={d.kind === 'locked' ? 'danger' : syncStateTone(d.syncState)}>
                      {d.kind === 'locked' ? 'Locked' : syncStateLabel(d.syncState)}
                    </Badge>
                  </p>
                  <p className="text-xs text-fg-muted">
                    Updated {formatDateTimeLabel(d.updatedAt)}
                    {d.kind === 'visit' && d.lastSyncError
                      ? ` · last sync: ${d.lastSyncError.code}: ${d.lastSyncError.reason}`
                      : ''}
                    {d.kind === 'visit'
                      ? ` · ${d.photos.length} photo${d.photos.length === 1 ? '' : 's'}`
                      : ''}
                  </p>
                  {d.kind === 'locked' ? (
                    <p className="text-xs text-danger">
                      Captured in a previous browser session; the key is gone so it cannot be read
                      or synced. It can only be discarded.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {d.kind === 'visit' ? (
                    <>
                      <Link
                        href={`/partner/visits/${d.offlineClientId}`}
                        className="sx-transition inline-flex h-9 items-center rounded-md border border-border-strong px-3 text-sm hover:bg-bg-sunken"
                      >
                        Open
                      </Link>
                      <Button
                        size="sm"
                        disabled={!online || busy !== null || !d.findingsMarkdown.trim()}
                        loading={busy === d.offlineClientId}
                        onClick={() => void sync(d)}
                      >
                        Sync
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDiscarding(d)}
                    aria-label={`Discard draft ${d.title}`}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog
        open={discarding !== null}
        onOpenChange={(o) => (!o ? setDiscarding(null) : undefined)}
      >
        {discarding ? (
          <DialogContent
            title="Discard this draft?"
            description="Anything not yet confirmed by the server is lost. This cannot be undone."
          >
            <p className="text-sm">{discarding.title}</p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDiscarding(null)}>
                Keep draft
              </Button>
              <Button variant="danger" onClick={() => void discard()}>
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </Card>
  );
}

export function VisitsList() {
  const p = usePartner();
  const params = useSearchParams();
  const filterProject = params.get('projectId');
  const projects = useQuery({
    queryKey: ['partner', 'projects'],
    queryFn: () => partnerFetch<Page<ProjectDto>>(withQuery('/api/v1/projects', { limit: 100 })),
  });
  const projectList = (projects.data?.items ?? []).filter(
    (pr) => !filterProject || pr.id === filterProject,
  );
  const visitQueries = useQueries({
    queries: projectList.map((pr) => ({
      queryKey: ['partner', 'site-visits', pr.id],
      queryFn: () =>
        partnerFetch<Page<SiteVisitDto>>(
          withQuery(`/api/v1/projects/${pr.id}/site-visits`, { limit: 50 }),
        ),
    })),
  });
  const rows = projectList.flatMap((pr, i) => {
    const q = visitQueries[i];
    return (q?.data?.items ?? [])
      .filter((v) => v.inspectorUserId === p.userId || p.isStaffInspector)
      .map((v) => ({ ...v, projectName: pr.name }));
  });
  const anyLoading = projects.isPending || visitQueries.some((q) => q.isPending);
  const failures = visitQueries.filter((q) => q.isError);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visits"
        description="Visits assigned to you, with instructions and checklist. Capture works offline; drafts stay encrypted on this device until you sync."
      />
      <LocalDrafts userId={p.userId} />
      <Card>
        <CardHeader>
          <CardTitle>Assigned visits</CardTitle>
          <p className="text-xs text-fg-muted">Times shown in {p.timeZone} and UTC.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {projects.isError ? (
            <RequestFailed
              error={projects.error}
              onRetry={() => void projects.refetch()}
              context="Projects"
            />
          ) : anyLoading ? (
            <LoadingBlock label="Loading visits" />
          ) : projectList.length === 0 ? (
            <EmptyState
              title="No projects"
              description="Visits belong to projects you are assigned to. Accept an assignment first; staff then schedule visits for you."
            />
          ) : (
            <>
              {failures.length > 0 ? (
                <Alert
                  tone="warning"
                  title={`${failures.length} project${failures.length === 1 ? '' : 's'} could not be loaded`}
                >
                  Their visits are not listed. Retry from the page header.
                </Alert>
              ) : null}
              <DataTable
                caption="Assigned visits"
                rows={rows}
                rowKey={(v) => v.id}
                rowLabel={(v) =>
                  `${v.projectName} ${v.scheduledAt ? formatDateTimeLabel(v.scheduledAt, p.timeZone) : ''}`
                }
                emptyMessage="No visits are scheduled for you on these projects. You can still start a field visit from a project below."
                columns={[
                  { key: 'project', header: 'Project', cell: (v) => v.projectName },
                  {
                    key: 'scheduled',
                    header: 'Scheduled',
                    cell: (v) => <DualTime iso={v.scheduledAt} zone={p.timeZone} />,
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (v) => <StatusBadge status={v.status} />,
                  },
                  {
                    key: 'evidence',
                    header: 'Evidence',
                    cell: (v) => `${v.evidenceCount} item${v.evidenceCount === 1 ? '' : 's'}`,
                  },
                  {
                    key: 'action',
                    header: 'Action',
                    cell: (v) => (
                      <Link href={`/partner/visits/${v.id}`} className="text-primary underline">
                        {v.status === 'scheduled' || v.status === 'in_progress'
                          ? 'Capture'
                          : 'View'}
                      </Link>
                    ),
                  },
                ]}
              />
              <div>
                <h3 className="text-sm font-medium">Start a field visit</h3>
                <p className="text-xs text-fg-muted">
                  For work not scheduled in advance. The visit is created on the server when you
                  sync.
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {projectList.map((pr) => (
                    <li key={pr.id}>
                      <Link
                        href={`/partner/visits/new?projectId=${pr.id}`}
                        className="sx-transition inline-flex h-9 items-center rounded-md border border-border-strong px-3 text-sm hover:bg-bg-sunken"
                      >
                        {pr.name} · {humanize(pr.kind)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
