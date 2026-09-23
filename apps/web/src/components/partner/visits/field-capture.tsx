'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, LocateFixed, Plus, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SiteVisitDto } from '@simplexd/contracts';
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
  PageHeader,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  useToast,
} from '@simplexd/ui';
import { isApiCode, partnerFetch } from '@/lib/partner/api';
import { normalizeChecklist } from '@/lib/partner/checklist';
import { usePartner } from '@/lib/partner/context';
import { OfflineError, syncVisitDraft } from '@/lib/partner/offline/sync';
import {
  newOfflineClientId,
  type ChecklistItem,
  type PhotoDraft,
  type VisitDraft,
} from '@/lib/partner/offline/types';
import {
  notifyDraftsChanged,
  useDraftStore,
  useOnline,
} from '@/lib/partner/offline/use-draft-store';
import { putBytes } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, RequestFailed } from '../common';
import { syncStateLabel, syncStateTone } from './visits-list';

/**
 * Field capture. `target` is one of:
 * - `visit_<offlineId>`: an existing local draft;
 * - `new` with `projectId`: a visit created in the field;
 * - a server site-visit id: opens (or creates) the draft for that visit.
 */
export function FieldCapture({ target, projectId }: { target: string; projectId: string | null }) {
  const p = usePartner();
  const router = useRouter();
  const { toast } = useToast();
  const online = useOnline();
  const { store, ready, sealingProblem, persistent } = useDraftStore(p.userId);
  const [draft, setDraft] = useState<VisitDraft | null>(null);
  const [locked, setLocked] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{
    tone: 'success' | 'info' | 'danger' | 'warning';
    text: string;
  } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const isLocalId = target.startsWith('visit_');
  const isNew = target === 'new';
  const serverVisitId = !isLocalId && !isNew ? target : null;

  const serverVisit = useQuery({
    queryKey: ['partner', 'site-visit', serverVisitId],
    queryFn: () => partnerFetch<SiteVisitDto>(`/api/v1/site-visits/${serverVisitId}`),
    enabled: serverVisitId !== null && online,
    retry: false,
  });
  const startVisit = useMutation({
    mutationFn: (d: VisitDraft) =>
      partnerFetch(`/api/v1/site-visits/${d.siteVisitId}/start`, {
        body: { startedAt: d.startedAt, offlineClientId: d.offlineClientId },
      }),
  });

  // Resolve the draft: existing local record, new field visit, or one derived from the server visit.
  useEffect(() => {
    if (!store || !ready || draft) return;
    let cancelled = false;
    (async () => {
      if (isLocalId) {
        const found = await store.get(target);
        if (cancelled) return;
        if (!found) return setLocked(true);
        if (found.kind === 'locked') return setLocked(true);
        if (found.kind === 'visit') setDraft(found);
        return;
      }
      const all = await store.list();
      if (cancelled) return;
      const nowIso = new Date().toISOString();
      if (isNew) {
        if (!projectId) return;
        setDraft({
          kind: 'visit',
          offlineClientId: newOfflineClientId('visit'),
          userId: p.userId,
          projectId,
          siteVisitId: null,
          title: `Field visit ${formatDateTimeLabel(nowIso, p.timeZone)}`,
          instructions: '',
          findingsMarkdown: '',
          checklist: [],
          weather: '',
          accessNote: '',
          gps: null,
          photos: [],
          startedAt: nowIso,
          submittedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          syncState: 'unsynced',
          serverVisitId: null,
          lastSyncAt: null,
          lastSyncError: null,
        });
        return;
      }
      const existing = all.find((d) => d.kind === 'visit' && d.siteVisitId === serverVisitId);
      if (existing && existing.kind === 'visit') {
        setDraft(existing);
        return;
      }
      if (!serverVisit.data) return; // wait for the server visit (needs to be online the first time)
      const v = serverVisit.data;
      if (v.status !== 'scheduled' && v.status !== 'in_progress') return; // read-only view handled below
      if (!v.projectId) return;
      const d: VisitDraft = {
        kind: 'visit',
        offlineClientId:
          v.offlineClientId && v.offlineClientId.startsWith('visit_')
            ? v.offlineClientId
            : newOfflineClientId('visit'),
        userId: p.userId,
        projectId: v.projectId,
        siteVisitId: v.id,
        title: `Visit ${v.scheduledAt ? formatDateTimeLabel(v.scheduledAt, p.timeZone) : v.id.slice(0, 8)}`,
        instructions: v.instructions ?? '',
        findingsMarkdown: v.findingsMarkdown ?? '',
        checklist: normalizeChecklist(v.checklist),
        weather: v.weather ?? '',
        accessNote: v.accessNote ?? '',
        gps: null,
        photos: [],
        startedAt: v.startedAt ?? nowIso,
        submittedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        syncState: 'unsynced',
        serverVisitId: null,
        lastSyncAt: null,
        lastSyncError: null,
      };
      setDraft(d);
      if (v.status === 'scheduled' && online) startVisit.mutate(d);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ready, target, serverVisit.data, projectId]);

  // Debounced autosave to the encrypted store.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!draft || !store || !dirtyRef.current) return;
    setSaveState('saving');
    const t = setTimeout(async () => {
      try {
        await store.put(draft);
        setSaveState('saved');
        setSavedAt(new Date().toISOString());
        notifyDraftsChanged();
      } catch {
        setSaveState('failed');
      }
    }, 500);
    return () => clearTimeout(t);
  }, [draft, store]);

  const update = useCallback((patch: Partial<VisitDraft>) => {
    dirtyRef.current = true;
    setDraft((d) =>
      d
        ? {
            ...d,
            ...patch,
            updatedAt: new Date().toISOString(),
            syncState: d.syncState === 'synced' ? 'unsynced' : d.syncState,
          }
        : d,
    );
  }, []);

  // Photo previews from decrypted bytes (object URLs revoked on unmount).
  useEffect(() => {
    if (!draft || !store) return;
    let alive = true;
    const urls: string[] = [];
    (async () => {
      const next: Record<string, string> = {};
      for (const ph of draft.photos) {
        if (previews[ph.id]) {
          next[ph.id] = previews[ph.id]!;
          continue;
        }
        const bytes = await store.getPhotoBytes(draft.offlineClientId, ph.id);
        if (!bytes) continue;
        const url = URL.createObjectURL(new Blob([bytes.bytes], { type: bytes.mime }));
        urls.push(url);
        next[ph.id] = url;
      }
      if (alive) setPreviews(next);
    })();
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.photos.length, store, draft?.offlineClientId]);

  async function addPhotos(files: FileList | null) {
    if (!files || !draft || !store) return;
    const added: PhotoDraft[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) {
        toast({ tone: 'danger', title: 'Not an image', description: `${f.name} was skipped.` });
        continue;
      }
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      try {
        await store.putPhotoBytes(draft.offlineClientId, id, f.type, await f.arrayBuffer());
      } catch (err) {
        toast({
          tone: 'danger',
          title: 'Could not store the photo',
          description: err instanceof Error ? err.message : 'storage failed',
        });
        continue;
      }
      added.push({
        id,
        name: f.name || `${id}.jpg`,
        mime: f.type,
        sizeBytes: f.size,
        capturedAt: new Date(f.lastModified || Date.now()).toISOString(),
        caption: '',
        fileId: null,
        evidenceId: null,
        state: 'pending',
        reason: null,
        retryable: false,
      });
    }
    if (added.length > 0) update({ photos: [...draft.photos, ...added] });
  }

  async function removePhoto(ph: PhotoDraft) {
    if (!draft || !store) return;
    await store.deletePhotoBytes(draft.offlineClientId, ph.id);
    update({ photos: draft.photos.filter((x) => x.id !== ph.id) });
  }

  function recordGps() {
    setGpsError(null);
    if (!('geolocation' in navigator))
      return setGpsError('This device does not expose a position.');
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        update({
          gps: {
            lat: Number(pos.coords.latitude.toFixed(6)),
            lon: Number(pos.coords.longitude.toFixed(6)),
            accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
            capturedAt: new Date(pos.timestamp).toISOString(),
            source: 'device_user_provided',
          },
        }),
      (err) => setGpsError(err.message || 'Position unavailable'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  async function sync() {
    if (!draft || !store) return;
    if (!draft.findingsMarkdown.trim()) {
      setSyncMessage({
        tone: 'warning',
        text: 'Write your findings before syncing; the server requires them.',
      });
      return;
    }
    setSyncing(true);
    setSyncMessage(null);
    try {
      // Flush any pending autosave first so the sync starts from the latest content.
      await store.put(draft);
      const outcome = await syncVisitDraft(
        { ...draft, submittedAt: draft.submittedAt ?? new Date().toISOString() },
        { api: partnerFetch, uploadBytes: putBytes, store },
      );
      notifyDraftsChanged();
      if (outcome.cleared) {
        toast({ tone: 'success', title: 'Visit synced', description: outcome.message });
        router.push('/partner/visits');
        return;
      }
      dirtyRef.current = false;
      setDraft(outcome.draft);
      setSyncMessage({
        tone: outcome.visitOutcome === 'rejected' ? 'danger' : 'info',
        text: outcome.message,
      });
    } catch (err) {
      setSyncMessage({
        tone: 'warning',
        text:
          err instanceof OfflineError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'sync failed',
      });
    } finally {
      setSyncing(false);
    }
  }

  async function discard() {
    if (!draft || !store) return;
    await store.delete(draft.offlineClientId);
    notifyDraftsChanged();
    router.push('/partner/visits');
  }

  const checklistDone = useMemo(
    () => (draft ? draft.checklist.filter((c) => c.checked).length : 0),
    [draft],
  );

  if (locked) {
    return (
      <Alert tone="danger" title="Draft cannot be opened">
        This draft was captured in a previous browser session, or does not exist. The encryption key
        is gone, so it can only be discarded from the visits list.
        <Link href="/partner/visits" className="ml-1 underline">
          Back to visits
        </Link>
      </Alert>
    );
  }
  if (isNew && !projectId) {
    return (
      <Alert tone="warning" title="Choose a project">
        A field visit needs a project. Start it from the visits list.
      </Alert>
    );
  }
  if (serverVisitId && !draft) {
    if (!online && serverVisit.isPending) {
      return (
        <Alert tone="warning" title="Offline and no local draft">
          This visit has not been opened on this device before, so its instructions are not
          available offline. Reconnect once to load it.
        </Alert>
      );
    }
    if (serverVisit.isPending) return <LoadingBlock rows={4} label="Loading visit" />;
    if (serverVisit.isError) {
      return isApiCode(serverVisit.error, 'not_found') ? (
        <Alert tone="warning" title="Visit not found">
          It may have been cancelled or is not assigned to you.
        </Alert>
      ) : (
        <RequestFailed
          error={serverVisit.error}
          onRetry={() => void serverVisit.refetch()}
          context="Visit"
        />
      );
    }
    const v = serverVisit.data;
    if (v.status !== 'scheduled' && v.status !== 'in_progress')
      return <ReadOnlyVisit visit={v} zone={p.timeZone} />;
    if (!v.projectId)
      return (
        <Alert tone="warning" title="Visit has no project">
          Field capture needs a project; ask staff to attach one.
        </Alert>
      );
  }
  if (!ready || !draft) return <LoadingBlock rows={4} label="Preparing capture" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/partner/visits" className="underline">
            Visits
          </Link>
        }
        title={draft.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={syncStateTone(draft.syncState)} role="status">
              {syncStateLabel(draft.syncState)}
            </Badge>
            {!online ? (
              <Badge tone="warning">
                <WifiOff aria-hidden="true" className="h-3 w-3" />
                Offline
              </Badge>
            ) : null}
            <span className="text-xs text-fg-muted" role="status" aria-live="polite">
              {saveState === 'saving'
                ? 'Saving on device…'
                : saveState === 'failed'
                  ? 'Could not save on device'
                  : savedAt
                    ? `Saved on device ${formatDateTimeLabel(savedAt, p.timeZone)}`
                    : 'Not yet saved on device'}
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setDiscardOpen(true)}>
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              Discard
            </Button>
            <Button
              onClick={() => void sync()}
              loading={syncing}
              disabled={!online || Boolean(sealingProblem)}
            >
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              Sync now
            </Button>
          </>
        }
      />
      {sealingProblem ? (
        <Alert tone="danger" title="Cannot store drafts on this device">
          {sealingProblem} You can still fill the form and sync while online, but a reload loses it.
        </Alert>
      ) : !persistent ? (
        <Alert tone="warning" title="Drafts live only while this page is open">
          IndexedDB is unavailable; a reload loses unsynced work. Sync as soon as you can.
        </Alert>
      ) : null}
      {syncMessage ? (
        <Alert tone={syncMessage.tone} title="Sync">
          {syncMessage.text}
        </Alert>
      ) : draft.lastSyncError ? (
        <Alert tone="warning" title={`Last sync did not complete (${draft.lastSyncError.code})`}>
          {draft.lastSyncError.reason}
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {draft.instructions ? (
            <Card>
              <CardHeader>
                <CardTitle>Instructions from staff</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm">
                {draft.instructions}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>
                Checklist{' '}
                <span className="text-sm font-normal text-fg-muted">
                  ({checklistDone}/{draft.checklist.length})
                </span>
              </CardTitle>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const label = window.prompt('Checklist item');
                  if (label?.trim())
                    update({
                      checklist: [
                        ...draft.checklist,
                        {
                          key: `custom_${Date.now().toString(36)}`,
                          label: label.trim(),
                          checked: false,
                        },
                      ],
                    });
                }}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add item
              </Button>
            </CardHeader>
            <CardContent>
              {draft.checklist.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No checklist was attached. Add items as you go.
                </p>
              ) : (
                <ul className="space-y-3">
                  {draft.checklist.map((item) => (
                    <ChecklistRow
                      key={item.key}
                      item={item}
                      onChange={(next) =>
                        update({
                          checklist: draft.checklist.map((c) => (c.key === item.key ? next : c)),
                        })
                      }
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Findings</CardTitle>
              <p className="text-xs text-fg-muted">
                Markdown. Encrypted on this device; sent to the server only when you sync.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Findings"
                htmlFor="capture-findings"
                required
                hint="What you observed, measured and could not verify."
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    className="min-h-48 font-mono text-sm"
                    value={draft.findingsMarkdown}
                    maxLength={100000}
                    onChange={(e) => update({ findingsMarkdown: e.target.value })}
                  />
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Weather" htmlFor="capture-weather">
                  {({ id }) => (
                    <Input
                      id={id}
                      maxLength={200}
                      value={draft.weather}
                      onChange={(e) => update({ weather: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Access note" htmlFor="capture-access">
                  {({ id }) => (
                    <Input
                      id={id}
                      maxLength={2000}
                      value={draft.accessNote}
                      onChange={(e) => update({ accessNote: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Photos</CardTitle>
              <p className="text-xs text-fg-muted">
                Stored encrypted here; uploaded, scanned and linked as evidence when you sync.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="sr-only"
                aria-label="Take or choose photos"
                onChange={(e) => {
                  void addPhotos(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => fileInput.current?.click()}
              >
                <Camera aria-hidden="true" className="h-4 w-4" />
                Take or choose photo
              </Button>
              {draft.photos.length === 0 ? (
                <p className="text-sm text-fg-muted">No photos yet.</p>
              ) : (
                <ul className="space-y-3">
                  {draft.photos.map((ph) => (
                    <li key={ph.id} className="rounded-md border border-border p-2 text-sm">
                      <div className="flex gap-3">
                        {previews[ph.id] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={previews[ph.id]}
                            alt={ph.caption || ph.name}
                            className="h-16 w-16 shrink-0 rounded object-cover"
                          />
                        ) : (
                          <div
                            className="h-16 w-16 shrink-0 rounded bg-bg-sunken"
                            aria-hidden="true"
                          />
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="truncate text-xs text-fg-muted">
                            {ph.name} · {(ph.sizeBytes / 1024).toFixed(0)} KB
                          </p>
                          <Badge
                            tone={
                              ph.state === 'linked'
                                ? 'success'
                                : ph.state === 'rejected'
                                  ? 'danger'
                                  : ph.state === 'uploaded'
                                    ? 'info'
                                    : 'warning'
                            }
                          >
                            {ph.state === 'pending'
                              ? 'On device'
                              : ph.state === 'uploaded'
                                ? ph.retryable
                                  ? 'Uploaded, scan pending'
                                  : 'Uploaded'
                                : ph.state === 'linked'
                                  ? 'Linked as evidence'
                                  : 'Rejected'}
                          </Badge>
                          {ph.reason ? <p className="text-xs text-danger">{ph.reason}</p> : null}
                          <Input
                            aria-label={`Caption for ${ph.name}`}
                            placeholder="Caption"
                            maxLength={1000}
                            value={ph.caption}
                            disabled={ph.state === 'linked'}
                            onChange={(e) =>
                              update({
                                photos: draft.photos.map((x) =>
                                  x.id === ph.id ? { ...x, caption: e.target.value } : x,
                                ),
                              })
                            }
                          />
                        </div>
                      </div>
                      {ph.state !== 'linked' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mt-1"
                          onClick={() => void removePhoto(ph)}
                          aria-label={`Remove ${ph.name}`}
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                          Remove
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Device position</CardTitle>
              <p className="text-xs text-fg-muted">
                Optional. Recorded as user-provided; it is not proof that you were on site.
              </p>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {draft.gps ? (
                <p>
                  {draft.gps.lat}, {draft.gps.lon}
                  {draft.gps.accuracyM !== null ? ` (±${draft.gps.accuracyM} m)` : ''}
                  <span className="block text-xs text-fg-muted">
                    Recorded {formatDateTimeLabel(draft.gps.capturedAt, p.timeZone)} ·
                    user-provided, not proof
                  </span>
                </p>
              ) : (
                <p className="text-fg-muted">No position recorded.</p>
              )}
              {gpsError ? <p className="text-xs text-danger">{gpsError}</p> : null}
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={recordGps}>
                  <LocateFixed aria-hidden="true" className="h-4 w-4" />
                  {draft.gps ? 'Update position' : 'Record position'}
                </Button>
                {draft.gps ? (
                  <Button size="sm" variant="ghost" onClick={() => update({ gps: null })}>
                    Clear
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-1 pt-5 text-xs text-fg-muted">
              <p>Started {formatDateTimeLabel(draft.startedAt, p.timeZone)}</p>
              <p>
                Offline id <code className="font-mono">{draft.offlineClientId}</code>
              </p>
              <p>Re-syncing the same id replays instead of duplicating.</p>
              {draft.serverVisitId ? (
                <p>Server visit {draft.serverVisitId.slice(0, 8)}… confirmed</p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent
          title="Discard this draft?"
          description="Findings, checklist and photos not confirmed by the server are deleted from this device. This cannot be undone."
        >
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDiscardOpen(false)}>
              Keep draft
            </Button>
            <Button variant="danger" onClick={() => void discard()}>
              Discard draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChecklistRow({
  item,
  onChange,
}: {
  item: ChecklistItem;
  onChange: (next: ChecklistItem) => void;
}) {
  const id = `chk-${item.key}`;
  return (
    <li className="space-y-1">
      <label htmlFor={id} className="sx-touch flex items-center gap-3">
        <input
          id={id}
          type="checkbox"
          className="h-5 w-5 accent-[var(--sx-primary)]"
          checked={item.checked}
          onChange={(e) => onChange({ ...item, checked: e.target.checked })}
        />
        <span>{item.label}</span>
      </label>
      <Input
        aria-label={`Note for ${item.label}`}
        placeholder="Note (optional)"
        className="h-9"
        value={item.note ?? ''}
        maxLength={1000}
        onChange={(e) => onChange({ ...item, note: e.target.value })}
      />
    </li>
  );
}

function ReadOnlyVisit({ visit, zone }: { visit: SiteVisitDto; zone: string }) {
  const checklist = normalizeChecklist(visit.checklist);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/partner/visits" className="underline">
            Visits
          </Link>
        }
        title={`Visit ${visit.scheduledAt ? formatDateTimeLabel(visit.scheduledAt, zone) : visit.id.slice(0, 8)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={visit.status} />
            {visit.submittedAt ? (
              <span>
                Submitted <DualTime iso={visit.submittedAt} zone={zone} />
              </span>
            ) : null}
          </span>
        }
      />
      <Alert tone="info" title="Read-only">
        This visit is {visit.status}; findings can no longer be changed here.
      </Alert>
      {visit.instructions ? (
        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">{visit.instructions}</CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Findings</CardTitle>
        </CardHeader>
        <CardContent className="whitespace-pre-wrap text-sm">
          {visit.findingsMarkdown ?? '—'}
        </CardContent>
      </Card>
      {checklist.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Checklist</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {checklist.map((c) => (
                <li key={c.key}>
                  {c.checked ? '☑' : '☐'} {c.label}
                  {c.note ? <span className="text-fg-muted"> — {c.note}</span> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <p className="text-sm text-fg-muted">
        {visit.evidenceCount} evidence item{visit.evidenceCount === 1 ? '' : 's'} ·{' '}
        <Link
          href={`/partner/evidence?projectId=${visit.projectId ?? ''}&siteVisitId=${visit.id}`}
          className="text-primary underline"
        >
          View evidence
        </Link>
      </p>
    </div>
  );
}
