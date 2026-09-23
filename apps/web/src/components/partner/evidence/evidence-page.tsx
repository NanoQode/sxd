'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Upload } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { EvidenceDto, Page, ProjectDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  StatusBadge,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { classifyFailure } from '@/lib/partner/offline/sync';
import { newOfflineClientId } from '@/lib/partner/offline/types';
import { openSignedDownload, uploadFile } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, RequestFailed } from '../common';

/** An uploaded file waiting for its malware scan before it can be linked. */
interface PendingLink {
  fileId: string;
  name: string;
  projectId: string;
  body: {
    fileId: string;
    kind: 'photo' | 'video' | 'document';
    caption: string | null;
    siteVisitId: string | null;
    /** Stable across retries, so a lost response never links the file twice. */
    offlineClientId: string;
  };
  state: 'waiting' | 'linking' | 'refused';
  reason: string | null;
}

const RETRY_MS = 15_000;

export function EvidencePage() {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const params = useSearchParams();
  const [projectId, setProjectId] = useState(params.get('projectId') ?? '');
  const siteVisitId = params.get('siteVisitId');
  const [caption, setCaption] = useState('');
  const [stage, setStage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLink[]>([]);
  const projects = useQuery({
    queryKey: ['partner', 'projects'],
    queryFn: () => partnerFetch<Page<ProjectDto>>(withQuery('/api/v1/projects', { limit: 100 })),
  });
  const effectiveProject = projectId || projects.data?.items[0]?.id || '';
  const evidence = useQuery({
    queryKey: ['partner', 'evidence', effectiveProject, siteVisitId],
    queryFn: () =>
      partnerFetch<Page<EvidenceDto>>(
        withQuery(`/api/v1/projects/${effectiveProject}/evidence`, {
          siteVisitId: siteVisitId ?? undefined,
          limit: 100,
        }),
      ),
    enabled: effectiveProject !== '',
  });
  /** Links an uploaded file; quarantined files stay in the waiting list. */
  const link = useCallback(
    async (item: PendingLink): Promise<'linked' | 'waiting' | 'refused'> => {
      setPending((list) =>
        list.map((x) => (x.fileId === item.fileId ? { ...x, state: 'linking' } : x)),
      );
      try {
        await partnerFetch<EvidenceDto & { idempotentReplay: boolean }>(
          `/api/v1/projects/${item.projectId}/evidence`,
          { body: item.body },
        );
        setPending((list) => list.filter((x) => x.fileId !== item.fileId));
        void qc.invalidateQueries({ queryKey: ['partner', 'evidence'] });
        return 'linked';
      } catch (err) {
        const kind = classifyFailure(err);
        const next: PendingLink['state'] = kind === 'definitive' ? 'refused' : 'waiting';
        setPending((list) =>
          list.map((x) =>
            x.fileId === item.fileId ? { ...x, state: next, reason: errorMessage(err) } : x,
          ),
        );
        return next;
      }
    },
    [qc],
  );

  // While files wait for their scan, retry the link periodically.
  useEffect(() => {
    if (!pending.some((x) => x.state === 'waiting')) return;
    const t = setInterval(() => {
      for (const item of pending) if (item.state === 'waiting') void link(item);
    }, RETRY_MS);
    return () => clearInterval(t);
  }, [pending, link]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const res = await uploadFile(
        file,
        { purpose: 'evidence', entityType: 'project', entityId: effectiveProject },
        setStage,
      );
      if (res.outcome === 'rejected')
        throw new Error(res.file.statusReason ?? 'the file was rejected after inspection');
      setStage('link');
      const kind: PendingLink['body']['kind'] = file.type.startsWith('image/')
        ? 'photo'
        : file.type.startsWith('video/')
          ? 'video'
          : 'document';
      const item: PendingLink = {
        fileId: res.file.id,
        name: file.name,
        projectId: effectiveProject,
        body: {
          fileId: res.file.id,
          kind,
          caption: caption.trim() || null,
          siteVisitId: siteVisitId ?? null,
          offlineClientId: newOfflineClientId('evidence'),
        },
        state: 'linking',
        reason: null,
      };
      setPending((list) => [...list, item]);
      return link(item);
    },
    onSuccess: (outcome) => {
      setCaption('');
      if (outcome === 'linked') toast({ tone: 'success', title: 'Evidence linked' });
      else if (outcome === 'waiting')
        toast({
          tone: 'info',
          title: 'Uploaded; waiting for the malware scan',
          description:
            'It is linked automatically once the scan passes while this page is open, or use Try linking now.',
        });
      else toast({ tone: 'danger', title: 'The server refused to link the file' });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not add evidence', description: errorMessage(err) }),
    onSettled: () => setStage(null),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Evidence"
        description="Files linked as evidence on projects you are assigned to. Legal and survey partners see only the projects assigned to them. Downloads use short-lived signed links."
        actions={
          projects.data && projects.data.items.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-fg-muted">Project</span>
              <NativeSelect
                aria-label="Project"
                value={effectiveProject}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.data.items.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null
        }
      />
      {projects.isPending ? (
        <LoadingBlock label="Loading projects" />
      ) : projects.isError ? (
        <RequestFailed
          error={projects.error}
          onRetry={() => void projects.refetch()}
          context="Projects"
        />
      ) : projects.data.items.length === 0 ? (
        <EmptyState
          title="No assigned projects"
          description="Evidence is scoped to projects. Accept an assignment to see its evidence."
        />
      ) : (
        <>
          {siteVisitId ? <Badge tone="info">Filtered to one visit</Badge> : null}
          <Card>
            <CardHeader>
              <CardTitle>Add evidence</CardTitle>
              <p className="text-xs text-fg-muted">
                Upload → malware scan → link. A file can only be linked after its scan passes; the
                field-capture page handles this automatically for photos taken on site.
              </p>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <Field label="Caption" htmlFor="evidence-caption" className="sm:col-span-2">
                {({ id }) => (
                  <Input
                    id={id}
                    maxLength={1000}
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex items-end">
                <label className="w-full">
                  <span className="sx-transition inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary hover:bg-primary-hover">
                    <Upload aria-hidden="true" className="h-4 w-4" />
                    {stage ? `${humanize(stage)}…` : 'Choose file'}
                  </span>
                  <input
                    type="file"
                    className="sr-only"
                    accept="image/*,video/mp4,video/quicktime,application/pdf"
                    disabled={upload.isPending}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) upload.mutate(f);
                    }}
                  />
                </label>
              </div>
            </CardContent>
          </Card>
          {pending.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Waiting to be linked</CardTitle>
                <p className="text-xs text-fg-muted">
                  Uploaded files become evidence only after the malware scan passes. Retries run
                  every {RETRY_MS / 1000} seconds while this page is open; the same link id is
                  reused, so nothing is linked twice.
                </p>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {pending.map((x) => (
                    <li
                      key={x.fileId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {x.name}
                          <Badge
                            tone={
                              x.state === 'refused'
                                ? 'danger'
                                : x.state === 'linking'
                                  ? 'info'
                                  : 'warning'
                            }
                          >
                            {x.state === 'refused'
                              ? 'Refused'
                              : x.state === 'linking'
                                ? 'Linking…'
                                : 'Scan pending'}
                          </Badge>
                        </p>
                        {x.reason ? <p className="text-xs text-fg-muted">{x.reason}</p> : null}
                      </div>
                      <div className="flex gap-2">
                        {x.state !== 'refused' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={x.state === 'linking'}
                            onClick={() => void link(x)}
                          >
                            Try linking now
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPending((list) => list.filter((y) => y.fileId !== x.fileId))
                          }
                        >
                          Dismiss
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          {evidence.isPending ? (
            <LoadingBlock label="Loading evidence" />
          ) : evidence.isError ? (
            <RequestFailed
              error={evidence.error}
              onRetry={() => void evidence.refetch()}
              context="Evidence"
            />
          ) : evidence.data.items.length === 0 ? (
            <EmptyState
              title="No evidence yet"
              description="Photos and documents linked on visits appear here once their scan passes."
            />
          ) : (
            <DataTable
              caption="Evidence"
              rows={evidence.data.items}
              rowKey={(e) => e.id}
              rowLabel={(e) => e.caption ?? e.file?.originalName ?? e.id}
              columns={[
                {
                  key: 'file',
                  header: 'File',
                  cell: (e) => (
                    <div>
                      <p className="font-medium">{e.caption ?? e.file?.originalName ?? '—'}</p>
                      <p className="text-xs text-fg-muted">
                        {humanize(e.kind)} · {e.file?.originalName ?? ''}{' '}
                        {e.file?.sizeBytes ? `· ${(e.file.sizeBytes / 1024).toFixed(0)} KB` : ''}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'status',
                  header: 'File status',
                  cell: (e) => <StatusBadge status={e.file?.status ?? 'unknown'} />,
                },
                {
                  key: 'received',
                  header: 'Received by server',
                  cell: (e) => <DualTime iso={e.receivedAt} zone={p.timeZone} />,
                },
                {
                  key: 'captured',
                  header: 'Captured (user-provided)',
                  cell: (e) => (
                    <span>
                      {e.capturedAt ? <DualTime iso={e.capturedAt} zone={p.timeZone} /> : '—'}
                      {e.captureGps ? (
                        <span className="block text-xs text-fg-muted">
                          GPS {e.captureGps.lat}, {e.captureGps.lon} (not proof)
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: 'publication',
                  header: 'Publication',
                  cell: (e) => (
                    <Badge tone={e.publication === 'restricted' ? 'neutral' : 'success'}>
                      {humanize(e.publication)}
                    </Badge>
                  ),
                },
                {
                  key: 'open',
                  header: 'Open',
                  cell: (e) => (
                    <OpenButton fileId={e.fileId} disabled={e.file?.status !== 'clean'} />
                  ),
                },
              ]}
            />
          )}
          {evidence.data?.items.some((e) => e.file?.status && e.file.status !== 'clean') ? (
            <Alert tone="info" title="Some files are not yet available">
              Files stay unavailable until the malware scan passes; rejected or infected files never
              become downloadable.
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

function OpenButton({ fileId, disabled }: { fileId: string; disabled: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled}
      loading={busy}
      title={disabled ? 'Not available until the scan passes' : undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await openSignedDownload(fileId, 'inline');
        } catch (err) {
          toast({ tone: 'danger', title: 'Not available', description: errorMessage(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Eye aria-hidden="true" className="h-4 w-4" />
      View
    </Button>
  );
}
