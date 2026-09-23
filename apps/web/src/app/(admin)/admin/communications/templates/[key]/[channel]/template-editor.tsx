'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type {
  SamplePreviewResponse,
  TemplateDto,
  TemplateFamilyDetailDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatNairaString,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../../../_components/action-dialog';
import { fmtDate, Mono } from '../../../../_components/bits';
import { CHANNEL_LABELS } from '../../../_lib/labels';

/**
 * Template family editor. The form is mounted per selected version (key on
 * the version id) so switching versions loads fresh content. Every save
 * creates or updates a draft version; approved and retired versions are
 * immutable. The preview is rendered on the server with sample values only.
 */

const BASE = '/api/v1/admin/notifications/templates';
const SMS_SEGMENT_LIMIT = 5;

interface Draft {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

function draftOf(t: TemplateDto | null): Draft {
  return { subject: t?.subject ?? '', bodyText: t?.bodyText ?? '', bodyHtml: t?.bodyHtml ?? '' };
}

function versionLabel(v: TemplateDto): string {
  const state = v.status === 'approved' ? 'active' : v.status;
  return `v${v.version} · ${state}`;
}

function SmsEstimate({ sms }: { sms: NonNullable<SamplePreviewResponse['sms']> }) {
  const over = sms.segments > SMS_SEGMENT_LIMIT;
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={sms.encoding === 'gsm7' ? 'success' : 'warning'}>
          {sms.encoding === 'gsm7' ? 'GSM-7' : 'Unicode (UCS-2)'}
        </Badge>
        <Badge tone={over ? 'danger' : sms.segments > 1 ? 'warning' : 'neutral'}>
          {sms.segments} segment{sms.segments === 1 ? '' : 's'}
        </Badge>
        <span className="text-fg-muted">
          {sms.characters} characters · {sms.units}/
          {sms.segments * sms.unitsPerSegment || sms.unitsPerSegment} units used ·{' '}
          {sms.remainingInSegment} left in this segment
        </span>
      </div>
      {sms.encoding === 'ucs2' ? (
        <p className="text-xs text-fg-muted">
          Unicode halves the characters per segment (70 / 67). Characters forcing it:{' '}
          {sms.unicodeCharacters.map((c) => (
            <Mono key={c}>{c}</Mono>
          ))}
        </p>
      ) : null}
      <p>
        Estimated cost per recipient:{' '}
        <strong>{formatNairaString(String(sms.estimatedCostKobo))}</strong>{' '}
        <span className="text-fg-muted">
          at {formatNairaString(String(sms.unitCostKobo))} per segment (
          {sms.unitCostSource === 'termii_settings'
            ? 'from the active Termii settings'
            : 'default price — set the unit cost in Admin → Integrations → Termii'}
          ). Rendered samples may differ in length from real values.
        </span>
      </p>
      {over ? (
        <p className="text-xs text-danger">
          Over {SMS_SEGMENT_LIMIT} segments: the server refuses to save or approve this body.
        </p>
      ) : null}
    </div>
  );
}

function PreviewPane({
  preview,
  error,
  loading,
}: {
  preview: SamplePreviewResponse | null;
  error: string | null;
  loading: boolean;
}) {
  const [view, setView] = useState<'html' | 'text'>('html');
  if (error) {
    return (
      <Alert tone="danger" title="Preview could not be rendered">
        {error}
      </Alert>
    );
  }
  if (!preview) return <p className="text-sm text-fg-muted">Rendering preview…</p>;
  return (
    <div className="space-y-3" aria-busy={loading}>
      {preview.missing.length > 0 ? (
        <Alert tone="warning" title="Variables without a sample value">
          Shown in brackets: {preview.missing.join(', ')}. A real send would fail with
          missing_variables unless the event supplies them.
        </Alert>
      ) : null}
      {preview.channel === 'email' ? (
        <>
          <p className="text-sm">
            <span className="text-fg-muted">Subject:</span>{' '}
            <strong>{preview.subject ?? '(none)'}</strong>
          </p>
          <div className="flex gap-1" role="group" aria-label="Preview format">
            <Button
              size="sm"
              variant={view === 'html' ? 'primary' : 'secondary'}
              aria-pressed={view === 'html'}
              onClick={() => setView('html')}
            >
              HTML
            </Button>
            <Button
              size="sm"
              variant={view === 'text' ? 'primary' : 'secondary'}
              aria-pressed={view === 'text'}
              onClick={() => setView('text')}
            >
              Plain text
            </Button>
          </div>
          {view === 'html' && preview.html ? (
            <iframe
              title="Email preview (sandboxed)"
              sandbox=""
              srcDoc={preview.html}
              className="h-[480px] w-full rounded-md border border-border bg-white"
            />
          ) : (
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-sunken p-3 font-mono text-xs">
              {preview.text}
            </pre>
          )}
        </>
      ) : preview.channel === 'sms' ? (
        <>
          <div className="max-w-sm rounded-2xl rounded-bl-sm border border-border bg-bg-sunken p-3 text-sm whitespace-pre-wrap">
            {preview.text}
          </div>
          {preview.sms ? <SmsEstimate sms={preview.sms} /> : null}
        </>
      ) : (
        <div className="rounded-md border border-border p-3">
          <p className="font-medium">{preview.subject ?? preview.text.split('\n')[0]}</p>
          {preview.subject ? (
            <p className="mt-1 text-sm text-fg-muted whitespace-pre-wrap">{preview.text}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function TemplateEditor({
  family,
  initialVersion,
}: {
  family: TemplateFamilyDetailDto;
  initialVersion: number | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string>(
    () =>
      (initialVersion !== null
        ? family.versions.find((v) => v.version === initialVersion)?.id
        : undefined) ??
      family.active?.id ??
      family.versions[0]!.id,
  );
  const selected =
    family.versions.find((v) => v.id === selectedId) ?? family.active ?? family.versions[0]!;
  const [dialog, setDialog] = useState<
    | { kind: 'rollback'; version: TemplateDto }
    | { kind: 'retire'; version: TemplateDto }
    | { kind: 'approve'; version: TemplateDto }
    | null
  >(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(version: TemplateDto, action: 'approve' | 'retire' | 'reopen') {
    const updated = await apiFetch<TemplateDto>(`${BASE}/${version.id}/actions`, {
      method: 'POST',
      body: { action },
    });
    toast({
      title:
        action === 'approve'
          ? `Version ${updated.version} is now active`
          : action === 'retire'
            ? `Version ${updated.version} retired`
            : `Version ${updated.version} reopened as a draft`,
      tone: 'success',
    });
    setSelectedId(updated.id);
    router.refresh();
  }

  async function restore(version: TemplateDto, activate: boolean, reason?: string) {
    const res = await apiFetch<{ template: TemplateDto; restoredFrom: number }>(
      `${BASE}/${version.id}/restore`,
      { method: 'POST', body: { activate, reason } },
    );
    toast({
      title: activate
        ? `Rolled back: version ${res.template.version} (copy of v${res.restoredFrom}) is active`
        : `Version ${res.template.version} created as a draft copy of v${res.restoredFrom}`,
      tone: 'success',
    });
    setSelectedId(res.template.id);
    router.replace(
      `/admin/communications/templates/${family.key}/${family.channel}?locale=${encodeURIComponent(family.locale)}&version=${res.template.version}`,
    );
    router.refresh();
  }

  async function quick(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      toast({ title: 'Action failed', description: errorMessage(err), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  const historyColumns: Column<TemplateDto>[] = [
    {
      key: 'version',
      header: 'Version',
      cell: (v) => <span className="font-medium">v{v.version}</span>,
    },
    {
      key: 'status',
      header: 'State',
      cell: (v) => (
        <StatusBadge status={v.status} label={v.status === 'approved' ? 'Active' : undefined} />
      ),
    },
    {
      key: 'approved',
      header: 'Approved',
      cell: (v) =>
        v.approvedAt ? (
          <span className="text-xs">{fmtDate(v.approvedAt)}</span>
        ) : (
          <span className="text-xs text-fg-muted">—</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'created',
      header: 'Created',
      cell: (v) => <span className="text-xs">{fmtDate(v.createdAt)}</span>,
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (v) => (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={v.id === selected.id}
            onClick={() => setSelectedId(v.id)}
          >
            {v.id === selected.id ? 'Viewing' : 'View'}
          </Button>
          {v.status === 'draft' ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => setDialog({ kind: 'approve', version: v })}
            >
              Activate
            </Button>
          ) : null}
          {v.status !== 'retired' ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => setDialog({ kind: 'retire', version: v })}
            >
              Retire
            </Button>
          ) : null}
          {v.status === 'retired' ? (
            <>
              <Button
                size="sm"
                variant="accent"
                disabled={busy !== null}
                onClick={() => setDialog({ kind: 'rollback', version: v })}
              >
                Roll back to v{v.version}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                loading={busy === `copy:${v.id}`}
                loadingLabel="Copying"
                onClick={() => quick(`copy:${v.id}`, () => restore(v, false))}
              >
                Copy to new draft
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <VersionForm
        key={selected.id}
        family={family}
        selected={selected}
        onSelectVersion={(id) => setSelectedId(id)}
        onSaved={(t) => {
          setSelectedId(t.id);
          router.replace(
            `/admin/communications/templates/${family.key}/${family.channel}?locale=${encodeURIComponent(family.locale)}&version=${t.version}`,
          );
          router.refresh();
        }}
        onActivate={() => setDialog({ kind: 'approve', version: selected })}
        onRetire={() => setDialog({ kind: 'retire', version: selected })}
        onReopen={() => quick('reopen', () => act(selected, 'reopen'))}
        busy={busy}
      />

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Every version is kept. Rolling back copies an older version into a new one and activates
            it; nothing is rewritten.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={historyColumns}
            rows={family.versions}
            rowKey={(v) => v.id}
            rowLabel={(v) => `version ${v.version}`}
            caption={`${family.key} ${family.channel} versions`}
          />
        </CardContent>
      </Card>

      <ActionDialog
        open={dialog?.kind === 'approve'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Activate version ${dialog?.version.version ?? ''}`}
        description={
          family.active
            ? `From now on version ${dialog?.version.version} sends for ${family.key} (${CHANNEL_LABELS[family.channel]}); version ${family.active.version} is retired and stays in the history.`
            : `From now on version ${dialog?.version.version} sends for ${family.key} (${CHANNEL_LABELS[family.channel]}).`
        }
        confirmLabel="Activate"
        onConfirm={() => (dialog ? act(dialog.version, 'approve') : Promise.resolve())}
      />
      <ActionDialog
        open={dialog?.kind === 'retire'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Retire version ${dialog?.version.version ?? ''}`}
        description={
          dialog?.version.status === 'approved'
            ? 'This is the active version. After retiring it, nothing sends for this template in production until another version is approved (a draft is used outside production and labelled).'
            : 'The draft stays in the history and can be reopened.'
        }
        confirmLabel="Retire"
        tone="danger"
        onConfirm={() => (dialog ? act(dialog.version, 'retire') : Promise.resolve())}
      />
      <ActionDialog
        open={dialog?.kind === 'rollback'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Roll back to version ${dialog?.version.version ?? ''}`}
        description={`Creates a new version with the content of v${dialog?.version.version} and activates it immediately${family.active ? `, retiring v${family.active.version}` : ''}. Recorded in the audit log with your reason.`}
        confirmLabel="Roll back"
        requireReason
        onConfirm={(reason) => (dialog ? restore(dialog.version, true, reason) : Promise.resolve())}
      />
    </div>
  );
}

function VersionForm({
  family,
  selected,
  onSelectVersion,
  onSaved,
  onActivate,
  onRetire,
  onReopen,
  busy,
}: {
  family: TemplateFamilyDetailDto;
  selected: TemplateDto;
  onSelectVersion: (id: string) => void;
  onSaved: (t: TemplateDto) => void;
  onActivate: () => void;
  onRetire: () => void;
  onReopen: () => void;
  busy: string | null;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(selected));
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<SamplePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const channel = family.channel;
  const dirty = useMemo(() => {
    const base = draftOf(selected);
    return (
      base.subject !== draft.subject ||
      base.bodyText !== draft.bodyText ||
      base.bodyHtml !== draft.bodyHtml
    );
  }, [draft, selected]);

  const emptyBody = !draft.bodyText.trim();

  // Live preview: server render with sample values only, debounced.
  useEffect(() => {
    if (emptyBody) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await apiFetch<SamplePreviewResponse>(`${BASE}/preview`, {
          method: 'POST',
          signal: controller.signal,
          body: {
            template: {
              channel,
              subject: draft.subject || null,
              bodyText: draft.bodyText,
              bodyHtml: channel === 'email' && draft.bodyHtml.trim() ? draft.bodyHtml : null,
            },
            sampleVariables: Object.fromEntries(
              Object.entries(overrides).filter(([, v]) => v.trim().length > 0),
            ),
          },
        });
        setPreview(res);
        setPreviewError(null);
      } catch (err) {
        if (!controller.signal.aborted) setPreviewError(errorMessage(err));
      } finally {
        if (!controller.signal.aborted) setPreviewing(false);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, overrides, channel, emptyBody]);

  const variables = preview?.variables ?? family.variables.map((v) => v.name);
  const samplesByName = new Map(
    (preview?.samples ?? family.variables).map((s) => [s.name, s] as const),
  );

  function payload() {
    return {
      subject: channel === 'sms' ? null : draft.subject.trim() || null,
      bodyText: draft.bodyText,
      bodyHtml: channel === 'email' && draft.bodyHtml.trim() ? draft.bodyHtml : null,
    };
  }

  async function saveDraft() {
    setSaving('draft');
    setError(null);
    try {
      const updated = await apiFetch<TemplateDto>(`${BASE}/${selected.id}`, {
        method: 'PATCH',
        body: { ...payload(), expectedUpdatedAt: selected.updatedAt },
      });
      toast({ title: `Draft v${updated.version} saved`, tone: 'success' });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  }

  async function saveAsNewVersion() {
    setSaving('new');
    setError(null);
    try {
      const created = await apiFetch<TemplateDto>(BASE, {
        method: 'POST',
        body: { key: family.key, channel, locale: family.locale, ...payload() },
      });
      toast({
        title: `Version ${created.version} saved as a draft`,
        description: 'Preview it, then activate it to make it the version that sends.',
        tone: 'success',
      });
      onSaved(created);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  }

  const isDraft = selected.status === 'draft';
  const locked = !isDraft;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[3fr_2fr]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                Version {selected.version}{' '}
                <StatusBadge
                  status={selected.status}
                  label={selected.status === 'approved' ? 'Active' : undefined}
                />
              </CardTitle>
              <Field label="Base version" className="min-w-48">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={selected.id}
                    onChange={(e) => onSelectVersion(e.target.value)}
                  >
                    {family.versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {versionLabel(v)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            <CardDescription>
              {isDraft
                ? 'Drafts can be edited in place. Activating retires the current active version.'
                : `This version is ${selected.status === 'approved' ? 'active' : 'retired'} and immutable. Your edits are saved as a new draft version.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              noValidate
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void (isDraft ? saveDraft() : saveAsNewVersion());
              }}
            >
              {error ? (
                <Alert tone="danger" title="Could not save">
                  {error}
                </Alert>
              ) : null}
              {channel !== 'sms' ? (
                <Field
                  label={channel === 'in_app' ? 'Title' : 'Subject'}
                  required={channel === 'email'}
                  hint="Placeholders use {{name}} syntax; every placeholder must be supplied by the event."
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={draft.subject}
                      onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                      maxLength={300}
                    />
                  )}
                </Field>
              ) : null}
              <Field
                label={channel === 'sms' ? 'Message' : 'Body (plain text)'}
                required
                hint={
                  channel === 'sms'
                    ? `Keep to ${SMS_SEGMENT_LIMIT} segments or fewer; non-GSM characters (curly quotes, emoji) switch to Unicode and halve the capacity.`
                    : channel === 'email'
                      ? 'Used for the text part and, when no HTML body is given, converted to the branded HTML layout.'
                      : 'Shown under the title in the in-app feed.'
                }
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={draft.bodyText}
                    onChange={(e) => setDraft((d) => ({ ...d, bodyText: e.target.value }))}
                    className={channel === 'sms' ? 'min-h-32 font-mono text-sm' : 'min-h-48'}
                    maxLength={20_000}
                  />
                )}
              </Field>
              {channel === 'email' ? (
                <Field
                  label="Body (HTML, optional)"
                  hint="Inserted into the branded layout; variables are HTML-escaped. Leave empty to derive HTML from the text body."
                >
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      value={draft.bodyHtml}
                      onChange={(e) => setDraft((d) => ({ ...d, bodyHtml: e.target.value }))}
                      className="min-h-32 font-mono text-xs"
                      maxLength={200_000}
                    />
                  )}
                </Field>
              ) : null}
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {isDraft ? (
                  <Button
                    type="submit"
                    disabled={!dirty || saving !== null || busy !== null}
                    loading={saving === 'draft'}
                    loadingLabel="Saving"
                  >
                    Save draft
                  </Button>
                ) : null}
                <Button
                  type={isDraft ? 'button' : 'submit'}
                  variant={isDraft ? 'secondary' : 'primary'}
                  disabled={saving !== null || busy !== null || (locked && !dirty)}
                  loading={saving === 'new'}
                  loadingLabel="Saving"
                  onClick={isDraft ? () => void saveAsNewVersion() : undefined}
                  title={locked && !dirty ? 'Change something first' : undefined}
                >
                  Save as new draft version
                </Button>
                {isDraft ? (
                  <Button
                    type="button"
                    variant="accent"
                    disabled={dirty || saving !== null || busy !== null}
                    title={dirty ? 'Save the draft first' : undefined}
                    onClick={onActivate}
                  >
                    Activate this version
                  </Button>
                ) : null}
                {selected.status !== 'retired' ? (
                  <Button
                    type="button"
                    variant="danger"
                    disabled={saving !== null || busy !== null}
                    onClick={onRetire}
                  >
                    Retire
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving !== null || busy !== null}
                    loading={busy === 'reopen'}
                    loadingLabel="Reopening"
                    onClick={onReopen}
                  >
                    Reopen as draft
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Variables</CardTitle>
            <CardDescription>
              Placeholders found in this content, with the sample values the preview uses. Type a
              value to try another sample; nothing here reads customer records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {variables.length === 0 ? (
              <p className="text-sm text-fg-muted">No placeholders in this template.</p>
            ) : (
              <ul className="divide-y divide-border">
                {variables.map((name) => {
                  const sample = samplesByName.get(name);
                  return (
                    <li
                      key={name}
                      className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center"
                    >
                      <div className="min-w-0">
                        <Mono>{`{{${name}}}`}</Mono>
                        <p className="mt-1 text-xs text-fg-muted">
                          {sample?.description ?? 'No curated sample'}
                          {sample?.source === 'derived' ? ' (generated from the name)' : ''}
                        </p>
                      </div>
                      <Field label={`Sample for ${name}`} className="sm:[&>label]:sr-only">
                        {({ id }) => (
                          <Input
                            id={id}
                            value={overrides[name] ?? ''}
                            placeholder={sample?.value ?? ''}
                            onChange={(e) =>
                              setOverrides((o) => ({ ...o, [name]: e.target.value }))
                            }
                            maxLength={2000}
                          />
                        )}
                      </Field>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 xl:sticky xl:top-4 xl:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              Rendered on the server from the content above with sample values — never with a real
              customer’s data.
              {family.sms ? (
                <>
                  {' '}
                  SMS price: {formatNairaString(String(family.sms.unitCostKobo))} per segment (
                  {family.sms.source === 'termii_settings' ? 'Termii settings' : 'default'}).
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PreviewPane
              preview={emptyBody ? null : preview}
              error={emptyBody ? 'Body text is required.' : previewError}
              loading={previewing}
            />
          </CardContent>
        </Card>
        <p className="text-xs text-fg-muted">
          Send this template to yourself from{' '}
          <Link href="/admin/communications/test-send" className="underline">
            Test send
          </Link>
          ; it renders with the same sample values.
        </p>
      </div>
    </div>
  );
}
