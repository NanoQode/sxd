'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTENT_FIELD_TEMPLATES, type ContentPageDetail, type ContentPageDto, type MediaAssetDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

type Action = 'submit_for_review' | 'approve' | 'publish' | 'schedule' | 'unpublish' | 'archive' | 'rollback';

/** Minimal line diff (LCS) for revision comparison; capped to keep it cheap. */
function lineDiff(a: string, b: string): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const x = a.split('\n').slice(0, 2000);
  const y = b.split('\n').slice(0, 2000);
  const n = x.length;
  const m = y.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: 'same', text: x[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: 'del', text: x[i]! });
      i += 1;
    } else {
      out.push({ type: 'add', text: y[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ type: 'del', text: x[i++]! });
  while (j < m) out.push({ type: 'add', text: y[j++]! });
  return out;
}

export function ContentEditor({ detail, canPublish, currentUserId }: { detail: ContentPageDetail; canPublish: boolean; currentUserId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const current = detail.revisions.find((r) => r.revision === detail.currentRevision) ?? detail.revisions[0]!;
  const [title, setTitle] = useState(current.title);
  const [summary, setSummary] = useState(current.summary ?? '');
  const [body, setBody] = useState(current.bodyMarkdown);
  const [fieldsJson, setFieldsJson] = useState(current.fields ? JSON.stringify(current.fields, null, 2) : '');
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState(current.bodyHtmlSanitized ?? '');
  const [previewState, setPreviewState] = useState<'idle' | 'rendering' | 'error'>('idle');
  const [seoTitle, setSeoTitle] = useState(detail.seo?.title ?? '');
  const [seoDescription, setSeoDescription] = useState(detail.seo?.description ?? '');
  const [seoCanonical, setSeoCanonical] = useState(detail.seo?.canonical ?? '');
  const [seoNoindex, setSeoNoindex] = useState(Boolean(detail.seo?.noindex));
  const [sortOrder, setSortOrder] = useState(String(detail.sortOrder));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<{ action: Action; revision?: number } | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [publishAt, setPublishAt] = useState('');
  const [mediaOpen, setMediaOpen] = useState(false);
  const [media, setMedia] = useState<MediaAssetDto[] | null>(null);
  const [diffPair, setDiffPair] = useState<[number | null, number | null]>([null, null]);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dirty = title !== current.title || summary !== (current.summary ?? '') || body !== current.bodyMarkdown || fieldsJson !== (current.fields ? JSON.stringify(current.fields, null, 2) : '');

  // Live sanitised preview rendered by the server (same sanitiser as save time).
  useEffect(() => {
    if (body === current.bodyMarkdown && current.bodyHtmlSanitized) {
      setPreviewHtml(current.bodyHtmlSanitized);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setPreviewState('rendering');
      try {
        const res = await apiFetch<{ html: string }>('/api/v1/admin/content/preview-render', { method: 'POST', body: { markdown: body }, signal: controller.signal });
        setPreviewHtml(res.html);
        setPreviewState('idle');
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) setPreviewState('error');
      }
    }, 500);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [body, current.bodyMarkdown, current.bodyHtmlSanitized]);

  function parseFields(): Record<string, unknown> | undefined | 'invalid' {
    if (!fieldsJson.trim()) return undefined;
    try {
      const parsed = JSON.parse(fieldsJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Fields must be a JSON object');
      setFieldsError(null);
      return parsed as Record<string, unknown>;
    } catch (err) {
      setFieldsError(err instanceof Error ? err.message : 'Invalid JSON');
      return 'invalid';
    }
  }

  async function saveRevision() {
    const fields = parseFields();
    if (fields === 'invalid') return;
    setBusy('save');
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/content/pages/${detail.id}/revisions`, {
        method: 'POST',
        body: { title, bodyMarkdown: body, summary: summary || undefined, fields, expectedVersion: detail.version },
      });
      toast({ title: `Revision ${detail.currentRevision + 1} saved`, tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveMeta() {
    setBusy('meta');
    setError(null);
    try {
      await apiFetch<ContentPageDto>(`/api/v1/admin/content/pages/${detail.id}`, {
        method: 'PATCH',
        body: {
          seo: { title: seoTitle || undefined, description: seoDescription || undefined, canonical: seoCanonical || undefined, noindex: seoNoindex || undefined },
          sortOrder: Number(sortOrder) || 0,
          expectedVersion: detail.version,
        },
      });
      toast({ title: 'SEO and ordering saved', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runAction() {
    if (!actionDialog) return;
    setBusy('action');
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/content/pages/${detail.id}/actions`, {
        method: 'POST',
        body: {
          action: actionDialog.action,
          revision: actionDialog.revision,
          publishAt: actionDialog.action === 'schedule' && publishAt ? new Date(publishAt).toISOString() : undefined,
          note: actionNote || undefined,
          expectedVersion: detail.version,
        },
      });
      toast({ title: `${humanize(actionDialog.action)} applied`, tone: 'success' });
      setActionDialog(null);
      setActionNote('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function openMedia() {
    setMediaOpen(true);
    if (media) return;
    try {
      const res = await apiFetch<{ items: MediaAssetDto[] }>('/api/v1/admin/content/media');
      setMedia(res.items);
    } catch (err) {
      setError(errorMessage(err));
      setMedia([]);
    }
  }

  function insertMedia(asset: MediaAssetDto) {
    const snippet = `\n![${asset.altText}](/media/${asset.id})\n`;
    const el = bodyRef.current;
    if (el) {
      const start = el.selectionStart ?? body.length;
      setBody(body.slice(0, start) + snippet + body.slice(start));
    } else {
      setBody(body + snippet);
    }
    setMediaOpen(false);
  }

  const currentAuthoredByMe = current.createdBy === currentUserId;
  const actions: Array<{ action: Action; label: string; show: boolean; variant?: 'primary' | 'secondary' | 'danger' }> = [
    { action: 'submit_for_review', label: 'Submit for review', show: detail.status !== 'archived' && current.reviewStatus === 'draft' },
    { action: 'approve', label: 'Approve', show: canPublish && current.reviewStatus === 'in_review', variant: 'secondary' },
    { action: 'publish', label: detail.publishedRevision === current.revision ? 'Republish' : 'Publish now', show: canPublish && detail.status !== 'archived', variant: 'primary' },
    { action: 'schedule', label: 'Schedule', show: canPublish && detail.status !== 'archived', variant: 'secondary' },
    { action: 'unpublish', label: 'Unpublish', show: canPublish && (detail.status === 'published' || detail.status === 'scheduled'), variant: 'secondary' },
    { action: 'archive', label: 'Archive', show: canPublish && detail.status !== 'archived', variant: 'danger' },
  ];
  const diff = useMemo(() => {
    const [a, b] = diffPair;
    if (a === null || b === null) return null;
    const ra = detail.revisions.find((r) => r.revision === a);
    const rb = detail.revisions.find((r) => r.revision === b);
    if (!ra || !rb) return null;
    return lineDiff(ra.bodyMarkdown, rb.bodyMarkdown);
  }, [diffPair, detail.revisions]);

  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="Action failed">
          {error}
        </Alert>
      ) : null}
      {detail.publishedRevision !== null && detail.currentRevision > detail.publishedRevision ? (
        <Alert tone="info" title="Unpublished changes">
          Revision {detail.currentRevision} is newer than the live revision {detail.publishedRevision}. The public site keeps serving the live revision until someone else publishes.
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revision {detail.currentRevision}</CardTitle>
            <CardDescription>
              Saving creates revision {detail.currentRevision + 1}. {dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Title" required>
              {({ id }) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />}
            </Field>
            <Field label="Summary">
              {({ id }) => <Input id={id} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500} />}
            </Field>
            <Field label="Body (Markdown)" hint="Rendered through the sanitiser: scripts, event handlers, iframes and unknown protocols are removed.">
              {({ id }) => <Textarea id={id} ref={bodyRef} rows={18} className="font-mono" value={body} onChange={(e) => setBody(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void openMedia()}>
                Insert approved media
              </Button>
              {CONTENT_FIELD_TEMPLATES[detail.kind] ? (
                <Button variant="secondary" size="sm" onClick={() => setFieldsJson(JSON.stringify(CONTENT_FIELD_TEMPLATES[detail.kind], null, 2))}>
                  Insert {humanize(detail.kind)} fields template
                </Button>
              ) : null}
            </div>
            <Field label="Fields (JSON)" hint="Structured data for this kind (FAQ question/answer, contact details, navigation items…)." error={fieldsError}>
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} rows={8} className="font-mono" aria-describedby={describedBy} aria-invalid={invalid} value={fieldsJson} onChange={(e) => setFieldsJson(e.target.value)} />
              )}
            </Field>
            <Button onClick={() => void saveRevision()} loading={busy === 'save'} loadingLabel="Saving" disabled={detail.status === 'archived'}>
              Save as revision {detail.currentRevision + 1}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live preview</CardTitle>
            <CardDescription>
              {previewState === 'rendering' ? 'Rendering…' : previewState === 'error' ? 'Preview failed; the saved revision still renders.' : 'Sanitised output exactly as the public site renders it.'}
              {' · '}
              <a href={`/preview/content/${detail.id}?rev=${detail.currentRevision}`} target="_blank" rel="noreferrer" className="text-primary underline">
                Open preview link (staff only)
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <h2 className="mb-3 font-display text-2xl font-semibold">{title}</h2>
            <div className="sx-prose" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workflow</CardTitle>
          <CardDescription>
            Status <Badge tone="neutral">{humanize(detail.status)}</Badge>; revision {current.revision} is {humanize(current.reviewStatus)}
            {currentAuthoredByMe ? ' and authored by you, so someone else must approve or publish it.' : '.'}
            {detail.publishAt ? ` Scheduled for ${formatDateTimeLabel(detail.publishAt)}.` : ''}
            {!canPublish ? ' You can edit and submit for review; publishing needs content.publish.' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {actions
            .filter((a) => a.show)
            .map((a) => (
              <Button
                key={a.action}
                variant={a.variant ?? 'secondary'}
                disabled={dirty || (currentAuthoredByMe && ['approve', 'publish', 'schedule'].includes(a.action))}
                title={dirty ? 'Save your changes first' : currentAuthoredByMe && ['approve', 'publish', 'schedule'].includes(a.action) ? 'The approver must differ from the author' : undefined}
                onClick={() => {
                  setActionNote('');
                  setPublishAt('');
                  setActionDialog({ action: a.action, revision: detail.currentRevision });
                }}
              >
                {a.label}
              </Button>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SEO and ordering</CardTitle>
          <CardDescription>Metadata for the public page. Private surfaces and previews are always noindex.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="SEO title" hint="Up to 70 characters.">
            {({ id }) => <Input id={id} maxLength={70} value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} />}
          </Field>
          <Field label="SEO description" hint="Up to 160 characters.">
            {({ id }) => <Input id={id} maxLength={160} value={seoDescription} onChange={(e) => setSeoDescription(e.target.value)} />}
          </Field>
          <Field label="Canonical URL" hint="Only when this page duplicates another URL.">
            {({ id }) => <Input id={id} type="url" value={seoCanonical} onChange={(e) => setSeoCanonical(e.target.value)} />}
          </Field>
          <Field label="Sort order" hint="Lower numbers appear first in listings.">
            {({ id }) => <Input id={id} type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />}
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={seoNoindex} onChange={(e) => setSeoNoindex(e.target.checked)} className="h-4 w-4" />
            Ask search engines not to index this page
          </label>
          <div className="sm:col-span-2">
            <Button variant="secondary" onClick={() => void saveMeta()} loading={busy === 'meta'} loadingLabel="Saving">
              Save SEO and ordering
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Revisions</CardTitle>
          <CardDescription>Select two revisions to compare; roll back re-publishes an earlier approved or published revision (someone other than its author).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="divide-y divide-border">
            {detail.revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" name="diff-a" checked={diffPair[0] === r.revision} onChange={() => setDiffPair([r.revision, diffPair[1]])} />A
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" name="diff-b" checked={diffPair[1] === r.revision} onChange={() => setDiffPair([diffPair[0], r.revision])} />B
                  </label>
                  <span className="font-medium">Revision {r.revision}</span>
                  <Badge tone={r.reviewStatus === 'published' ? 'success' : r.reviewStatus === 'approved' ? 'primary' : r.reviewStatus === 'in_review' ? 'info' : 'neutral'}>
                    {humanize(r.reviewStatus)}
                  </Badge>
                  {detail.publishedRevision === r.revision ? <Badge tone="gold">Live</Badge> : null}
                  <span className="text-fg-muted">
                    {r.createdByName ?? 'Seed'} · {formatDateTimeLabel(r.createdAt)}
                  </span>
                </span>
                <span className="flex gap-2">
                  <a href={`/preview/content/${detail.id}?rev=${r.revision}`} target="_blank" rel="noreferrer" className="text-primary underline">
                    Preview
                  </a>
                  {canPublish && detail.publishedRevision !== r.revision && (r.reviewStatus === 'published' || r.reviewStatus === 'approved') ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={r.createdBy === currentUserId}
                      title={r.createdBy === currentUserId ? 'You authored this revision' : undefined}
                      onClick={() => {
                        setActionNote('');
                        setActionDialog({ action: 'rollback', revision: r.revision });
                      }}
                    >
                      Roll back to {r.revision}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          {diff ? (
            <div className="overflow-x-auto rounded-md border border-border bg-bg-sunken p-3 font-mono text-xs">
              <p className="mb-2 text-fg-muted">
                Comparing revision {diffPair[0]} (A) with {diffPair[1]} (B)
              </p>
              {diff.map((line, i) => (
                <div
                  key={i}
                  className={line.type === 'add' ? 'bg-success-soft text-success' : line.type === 'del' ? 'bg-danger-soft text-danger line-through' : ''}
                >
                  <span className="mr-2 select-none text-fg-subtle">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                  {line.text || ' '}
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={actionDialog !== null} onOpenChange={(o) => !o && setActionDialog(null)}>
        {actionDialog ? (
          <DialogContent
            title={humanize(actionDialog.action)}
            description={
              actionDialog.action === 'publish'
                ? `Publishes revision ${actionDialog.revision} to the public site immediately and clears the content cache.`
                : actionDialog.action === 'schedule'
                  ? 'The revision becomes public at the chosen time; it stays hidden until then.'
                  : actionDialog.action === 'rollback'
                    ? `Re-publishes revision ${actionDialog.revision}. History is retained.`
                    : actionDialog.action === 'unpublish'
                      ? 'Removes the page from the public site; the revision history stays.'
                      : actionDialog.action === 'archive'
                        ? 'Archives the page: no longer public and no longer editable.'
                        : undefined
            }
            size="sm"
          >
            <div className="space-y-3">
              {actionDialog.action === 'schedule' ? (
                <Field label="Publish at (your local time)" required>
                  {({ id }) => <Input id={id} type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />}
                </Field>
              ) : null}
              <Field label="Note" hint="Recorded in the audit trail.">
                {({ id }) => <Textarea id={id} rows={2} maxLength={1000} value={actionNote} onChange={(e) => setActionNote(e.target.value)} />}
              </Field>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setActionDialog(null)} disabled={busy === 'action'}>
                  Cancel
                </Button>
                <Button
                  variant={actionDialog.action === 'archive' ? 'danger' : 'primary'}
                  onClick={() => void runAction()}
                  loading={busy === 'action'}
                  disabled={actionDialog.action === 'schedule' && !publishAt}
                >
                  Confirm
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={mediaOpen} onOpenChange={setMediaOpen}>
        <DialogContent title="Approved media" description="Only assets approved for public use are listed. Uploads and public delivery arrive in Wave 2; private evidence is never reachable from here." size="lg">
          {media === null ? (
            <p className="text-sm text-fg-muted">Loading…</p>
          ) : media.length === 0 ? (
            <p className="text-sm text-fg-muted">No approved media assets yet. Once uploads land in Wave 2, assets approved with confirmed rights appear here.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {media.map((m) => (
                <li key={m.id} className="rounded-md border border-border p-3 text-sm">
                  <p className="font-medium">{m.altText}</p>
                  <p className="text-xs text-fg-muted">
                    {m.originalName} · {m.declaredMime}
                    {m.rightsConfirmed ? ' · rights confirmed' : ' · rights unconfirmed'}
                  </p>
                  <Button variant="secondary" size="sm" className="mt-2" onClick={() => insertMedia(m)}>
                    Insert
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
