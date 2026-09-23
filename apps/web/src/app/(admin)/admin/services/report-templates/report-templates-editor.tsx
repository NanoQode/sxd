'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { reportKindSchema } from '@simplexd/contracts';
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
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import type {
  ReportKind,
  ReportTemplateDto,
  ReportTemplateSectionDto,
} from '@/server/admin/configuration/report-templates';
import { ActionDialog } from '../../_components/action-dialog';
import { fmtDate } from '../../_components/bits';

const KINDS = reportKindSchema.options;

const EMPTY_SECTION: ReportTemplateSectionDto = {
  key: '',
  heading: '',
  guidance: '',
  required: true,
};

function keyFromHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 60);
}

export function ReportTemplatesEditor({
  items,
  canManage,
}: {
  items: ReportTemplateDto[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<ReportTemplateDto | 'new' | null>(null);
  const [kind, setKind] = useState<ReportKind>('progress');
  const [name, setName] = useState('');
  const [sections, setSections] = useState<ReportTemplateSectionDto[]>([{ ...EMPTY_SECTION }]);
  const [limitations, setLimitations] = useState('');
  const [active, setActive] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState<ReportTemplateDto | null>(null);

  function open(t: ReportTemplateDto | 'new') {
    setEditing(t);
    setError(null);
    setReason('');
    if (t === 'new') {
      setKind('progress');
      setName('');
      setSections([{ ...EMPTY_SECTION }]);
      setLimitations('');
      setActive(false);
    } else {
      setKind(t.kind);
      setName(t.name);
      setSections(t.sections.map((s) => ({ ...s, guidance: s.guidance ?? '' })));
      setLimitations(t.limitationsMarkdown ?? '');
      setActive(t.active);
    }
  }

  function updateSection(i: number, patch: Partial<ReportTemplateSectionDto>) {
    setSections(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSections(next);
  }

  const cleanSections = sections.map((s) => ({
    key: s.key || keyFromHeading(s.heading),
    heading: s.heading.trim(),
    ...(s.guidance?.trim() ? { guidance: s.guidance.trim() } : {}),
    required: s.required,
  }));
  const keys = new Set(cleanSections.map((s) => s.key));
  const sectionsOk =
    cleanSections.length > 0 &&
    cleanSections.every((s) => s.heading.length >= 2 && /^[a-z][a-z0-9_]{0,59}$/.test(s.key)) &&
    keys.size === cleanSections.length;
  const ready =
    name.trim().length >= 3 &&
    sectionsOk &&
    limitations.trim().length >= 10 &&
    (editing === 'new' || reason.trim().length >= 3);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') {
        await adminFetch('/api/v1/admin/report-templates', {
          body: {
            kind,
            name: name.trim(),
            sections: cleanSections,
            limitationsMarkdown: limitations.trim(),
            active,
          },
        });
        toast({ title: 'Report template created', tone: 'success' });
      } else if (editing) {
        await adminFetch(`/api/v1/admin/report-templates/${editing.id}`, {
          method: 'PATCH',
          body: {
            name: name.trim(),
            sections: cleanSections,
            limitationsMarkdown: limitations.trim(),
            active,
            expectedVersion: editing.version,
            reason: reason.trim(),
          },
        });
        toast({ title: 'Report template updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate(r: string) {
    if (!activating) return;
    await adminFetch(`/api/v1/admin/report-templates/${activating.id}`, {
      method: 'PATCH',
      body: { active: true, expectedVersion: activating.version, reason: r },
    });
    toast({
      title: `${activating.name} is now the active ${humanize(activating.kind)} template`,
      tone: 'success',
    });
    router.refresh();
  }

  const byKind = new Map<string, ReportTemplateDto[]>();
  for (const t of items) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);

  return (
    <div className="space-y-6">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => open('new')}>New template</Button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-fg-muted">
          No report templates yet. Run the seed (pnpm db:seed) for the starter templates or create
          one here.
        </p>
      ) : null}
      {KINDS.filter((k) => byKind.has(k)).map((k) => (
        <section key={k} aria-labelledby={`kind-${k}`} className="space-y-2">
          <h2 id={`kind-${k}`} className="text-lg font-semibold">
            {humanize(k)}
          </h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {(byKind.get(k) ?? []).map((t) => (
              <li key={t.id} className="rounded-lg border border-border bg-bg-elevated p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {t.name}{' '}
                    {t.active ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </p>
                  <span className="text-xs text-fg-muted">
                    v{t.version} · {fmtDate(t.updatedAt)}
                  </span>
                </div>
                <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm">
                  {t.sections.map((s) => (
                    <li key={s.key}>
                      {s.heading}
                      {s.required ? '' : <span className="text-fg-muted"> (optional)</span>}
                    </li>
                  ))}
                </ol>
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-fg-muted">
                    Scope and limitations wording
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-fg-muted">
                    {t.limitationsMarkdown ?? '—'}
                  </p>
                </details>
                {canManage ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => open(t)}>
                      Edit
                    </Button>
                    {!t.active ? (
                      <Button size="sm" variant="ghost" onClick={() => setActivating(t)}>
                        Make active
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Dialog open={editing !== null} onOpenChange={(v) => !busy && !v && setEditing(null)}>
        <DialogContent
          className={DIALOG_MAX_H}
          size="lg"
          title={
            editing === 'new'
              ? 'New report template'
              : `Edit ${editing === null ? '' : editing.name}`
          }
          description="Sections are the report outline in order; guidance is shown to the author only. The limitations wording is appended to every report of this kind."
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Report kind" required>
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={kind}
                    disabled={editing !== 'new'}
                    onChange={(e) => setKind(e.target.value as ReportKind)}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {humanize(k)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Name" required>
                {({ id }) => (
                  <Input
                    id={id}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                  />
                )}
              </Field>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Sections (in order)</p>
              {sections.map((s, i) => (
                <div key={i} className="rounded-md border border-border p-2">
                  <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
                    <Input
                      aria-label={`Section ${i + 1} heading`}
                      placeholder="Heading"
                      value={s.heading}
                      onChange={(e) =>
                        updateSection(i, {
                          heading: e.target.value,
                          key:
                            s.key && s.key !== keyFromHeading(s.heading)
                              ? s.key
                              : keyFromHeading(e.target.value),
                        })
                      }
                    />
                    <Input
                      aria-label={`Section ${i + 1} key`}
                      placeholder="key (snake_case)"
                      value={s.key}
                      onChange={(e) => updateSection(i, { key: e.target.value })}
                      className="font-mono text-xs"
                    />
                  </div>
                  <Input
                    aria-label={`Section ${i + 1} guidance`}
                    placeholder="Guidance for the author (optional)"
                    value={s.guidance ?? ''}
                    onChange={(e) => updateSection(i, { guidance: e.target.value })}
                    className="mt-2"
                    maxLength={2000}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={s.required}
                        onChange={(e) => updateSection(i, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move section ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move section ${i + 1} down`}
                      disabled={i === sections.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove section ${i + 1}`}
                      disabled={sections.length === 1}
                      onClick={() => setSections(sections.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSections([...sections, { ...EMPTY_SECTION }])}
              >
                Add section
              </Button>
              {!sectionsOk && sections.some((s) => s.heading) ? (
                <p className="text-xs text-danger">
                  Every section needs a heading and a unique snake_case key.
                </p>
              ) : null}
            </div>
            <Field
              label="Scope and limitations wording"
              required
              hint="Plain statement of what the report does and does not do. Do not promise legal, structural or title guarantees."
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  value={limitations}
                  onChange={(e) => setLimitations(e.target.value)}
                  className="min-h-32"
                  maxLength={8000}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Active for this kind (the other active template of the kind is deactivated)
            </label>
            {editing !== 'new' ? (
              <Field
                label="Reason (recorded in the audit log)"
                required
                hint="At least 3 characters."
              >
                {({ id }) => (
                  <Textarea
                    id={id}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-h-14"
                  />
                )}
              </Field>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ready} onClick={() => void save()}>
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ActionDialog
        open={activating !== null}
        onOpenChange={(o) => !o && setActivating(null)}
        title={`Make "${activating?.name ?? ''}" the active ${activating ? humanize(activating.kind) : ''} template`}
        description="New reports of this kind will start from it. The currently active template is deactivated; existing reports keep their own sections."
        confirmLabel="Activate"
        requireReason
        onConfirm={activate}
      />
    </div>
  );
}
