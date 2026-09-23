'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import type { NeighborhoodDto } from '@/server/admin/market-data/neighborhoods';
import { ActionDialog } from '../../../../_components/action-dialog';
import { fmtDate } from '../../../../_components/bits';

interface FormState {
  name: string;
  slug: string;
  boundaryGeoJson: string;
  boundarySourceId: string;
  boundaryNote: string;
  profileMarkdown: string;
  changeReason: string;
}

const empty: FormState = {
  name: '',
  slug: '',
  boundaryGeoJson: '',
  boundarySourceId: '',
  boundaryNote: '',
  profileMarkdown: '',
  changeReason: '',
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function NeighborhoodsTab({
  marketId,
  items,
  sources,
  canEdit,
  canPublish,
}: {
  marketId: string;
  items: NeighborhoodDto[];
  sources: Array<{ id: string; title: string }>;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<NeighborhoodDto | null | 'new'>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transition, setTransition] = useState<{
    n: NeighborhoodDto;
    to: 'published' | 'unpublished' | 'archived';
  } | null>(null);

  function open(n: NeighborhoodDto | 'new') {
    setEditing(n);
    setError(null);
    setForm(
      n === 'new'
        ? empty
        : {
            name: n.name,
            slug: n.slug,
            boundaryGeoJson: n.boundaryGeoJson ?? '',
            boundarySourceId: n.boundarySourceId ?? '',
            boundaryNote: n.boundaryNote ?? '',
            profileMarkdown: n.profileMarkdown ?? '',
            changeReason: '',
          },
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        boundaryGeoJson: form.boundaryGeoJson.trim() || null,
        boundarySourceId: form.boundarySourceId || null,
        boundaryNote: form.boundaryNote || null,
        profileMarkdown: form.profileMarkdown || null,
      };
      if (editing === 'new') {
        await apiFetch(`/api/v1/admin/markets/${marketId}/neighborhoods`, {
          body: { ...body, changeReason: form.changeReason || undefined },
        });
        toast({ title: 'Neighborhood created', tone: 'success' });
      } else if (editing) {
        if (form.changeReason.trim().length < 3)
          throw new Error('Give a change reason (at least 3 characters).');
        await apiFetch(`/api/v1/admin/markets/${marketId}/neighborhoods/${editing.id}`, {
          method: 'PATCH',
          body: { ...body, expectedVersion: editing.version, changeReason: form.changeReason },
        });
        toast({ title: 'Neighborhood updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyTransition(reason: string) {
    if (!transition) return;
    await apiFetch(`/api/v1/admin/markets/${marketId}/neighborhoods/${transition.n.id}`, {
      method: 'PATCH',
      body: {
        publicationState: transition.to,
        expectedVersion: transition.n.version,
        changeReason: reason,
      },
    });
    toast({ title: `${transition.n.name}: ${transition.to}`, tone: 'success' });
    router.refresh();
  }

  const columns: Column<NeighborhoodDto>[] = [
    {
      key: 'name',
      header: 'Neighborhood',
      cell: (n) => (
        <span className="font-medium">
          {n.name}
          <span className="block font-mono text-xs text-fg-muted">{n.slug}</span>
        </span>
      ),
    },
    {
      key: 'boundary',
      header: 'Boundary',
      cell: (n) =>
        n.boundaryGeoJson ? (
          <span className="text-xs">
            MultiPolygon
            {n.centroid
              ? ` · centroid ${n.centroid.lon.toFixed(3)}, ${n.centroid.lat.toFixed(3)}`
              : ''}
          </span>
        ) : (
          <span className="text-xs text-fg-muted">None</span>
        ),
    },
    {
      key: 'state',
      header: 'Publication',
      cell: (n) => <StatusBadge status={n.publicationState} />,
    },
    {
      key: 'updated',
      header: 'Updated',
      hideOnMobile: true,
      cell: (n) => (
        <span className="text-xs text-fg-muted">
          v{n.version} · {fmtDate(n.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (n) => (
        <div className="flex flex-wrap gap-1">
          {(n.publicationState === 'published' ? canPublish : canEdit) &&
          n.publicationState !== 'archived' ? (
            <Button size="sm" variant="secondary" onClick={() => open(n)}>
              Edit
            </Button>
          ) : null}
          {canPublish && n.publicationState !== 'published' && n.publicationState !== 'archived' ? (
            <Button size="sm" onClick={() => setTransition({ n, to: 'published' })}>
              Publish
            </Button>
          ) : null}
          {canPublish && n.publicationState === 'published' ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setTransition({ n, to: 'unpublished' })}
            >
              Unpublish
            </Button>
          ) : null}
          {(n.publicationState === 'published' ? canPublish : canEdit) &&
          n.publicationState !== 'archived' ? (
            <Button size="sm" variant="ghost" onClick={() => setTransition({ n, to: 'archived' })}>
              Archive
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          Neighborhoods live under the stable market id. Boundaries are GeoJSON MultiPolygons
          validated by PostGIS.
        </p>
        {canEdit ? (
          <Button size="sm" onClick={() => open('new')}>
            Add neighborhood
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(n) => n.id}
        rowLabel={(n) => n.name}
        caption="Neighborhoods"
        emptyMessage="No neighborhoods yet."
      />

      <Dialog open={editing !== null} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent
          title={editing === 'new' ? 'Add neighborhood' : `Edit ${editing?.name ?? ''}`}
          size="lg"
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name" required>
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        name: e.target.value,
                        slug: editing === 'new' ? slugify(e.target.value) : f.slug,
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="Slug" required hint="Unique within the market.">
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.slug}
                    onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Boundary source">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={form.boundarySourceId}
                    onChange={(e) => setForm((f) => ({ ...f, boundarySourceId: e.target.value }))}
                  >
                    <option value="">Unspecified</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Boundary note">
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.boundaryNote}
                    onChange={(e) => setForm((f) => ({ ...f, boundaryNote: e.target.value }))}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Boundary GeoJSON (Polygon or MultiPolygon)"
              hint='Example: {"type":"Polygon","coordinates":[[[3.35,6.5],[3.45,6.5],[3.45,6.6],[3.35,6.6],[3.35,6.5]]]}'
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  className="min-h-32 font-mono text-xs"
                  value={form.boundaryGeoJson}
                  onChange={(e) => setForm((f) => ({ ...f, boundaryGeoJson: e.target.value }))}
                />
              )}
            </Field>
            <Field label="Profile (Markdown)">
              {({ id }) => (
                <Textarea
                  id={id}
                  className="min-h-24"
                  value={form.profileMarkdown}
                  onChange={(e) => setForm((f) => ({ ...f, profileMarkdown: e.target.value }))}
                />
              )}
            </Field>
            <Field
              label={editing === 'new' ? 'Reason (optional)' : 'Change reason'}
              required={editing !== 'new'}
            >
              {({ id }) => (
                <Input
                  id={id}
                  value={form.changeReason}
                  onChange={(e) => setForm((f) => ({ ...f, changeReason: e.target.value }))}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={save}
                loading={busy}
                loadingLabel="Saving"
                disabled={!form.name.trim() || !form.slug.trim()}
              >
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ActionDialog
        open={transition !== null}
        onOpenChange={(o) => !o && setTransition(null)}
        title={
          transition
            ? `${transition.to === 'archived' ? 'Archive' : transition.to === 'published' ? 'Publish' : 'Unpublish'} ${transition.n.name}`
            : ''
        }
        confirmLabel={
          transition?.to === 'archived'
            ? 'Archive'
            : transition?.to === 'published'
              ? 'Publish'
              : 'Unpublish'
        }
        tone={transition?.to === 'published' ? 'primary' : 'danger'}
        requireReason
        onConfirm={applyTransition}
      />
    </div>
  );
}
