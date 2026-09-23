'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Upload } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
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
import { newOfflineClientId } from '@/lib/partner/offline/types';
import { openSignedDownload, uploadFile } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, RequestFailed } from '../common';

export function EvidencePage() {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const params = useSearchParams();
  const [projectId, setProjectId] = useState(params.get('projectId') ?? '');
  const siteVisitId = params.get('siteVisitId');
  const [caption, setCaption] = useState('');
  const [stage, setStage] = useState<string | null>(null);
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
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const res = await uploadFile(
        file,
        { purpose: 'evidence', entityType: 'project', entityId: effectiveProject },
        setStage,
      );
      if (res.outcome === 'rejected')
        throw new Error(res.file.statusReason ?? 'the file was rejected');
      setStage('link');
      const kind = file.type.startsWith('image/')
        ? 'photo'
        : file.type.startsWith('video/')
          ? 'video'
          : 'document';
      return partnerFetch<EvidenceDto & { idempotentReplay: boolean }>(
        `/api/v1/projects/${effectiveProject}/evidence`,
        {
          body: {
            fileId: res.file.id,
            kind,
            caption: caption.trim() || null,
            siteVisitId: siteVisitId ?? null,
            offlineClientId: newOfflineClientId('evidence'),
          },
        },
      );
    },
    onSuccess: () => {
      toast({ tone: 'success', title: 'Evidence linked' });
      setCaption('');
      void qc.invalidateQueries({ queryKey: ['partner', 'evidence'] });
    },
    onError: (err) => {
      const msg = errorMessage(err);
      toast({
        tone: 'danger',
        title:
          msg.includes('malware') || msg.includes('scan')
            ? 'Uploaded, scan pending'
            : 'Could not add evidence',
        description:
          msg.includes('malware') || msg.includes('scan')
            ? 'The file is being scanned. Link it from the field-capture sync later, or retry here once the scan passes.'
            : msg,
      });
    },
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
