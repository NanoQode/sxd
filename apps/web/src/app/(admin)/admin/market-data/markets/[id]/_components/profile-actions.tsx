'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, NativeSelect, useToast } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../../../_components/action-dialog';
import { NigeriaPointPicker, insideNigeria } from '../../_components/point-picker';

type Action = 'publish' | 'unpublish' | 'archive' | 'restore' | 'move' | 'merge';

export function ProfileActions({
  market,
  canEdit,
  canPublish,
  sources,
  markets,
}: {
  market: {
    id: string;
    name: string;
    version: number;
    publicationState: string;
    location: { lon: number; lat: number };
    mergedIntoMarketId: string | null;
    coordinateSourceId: string | null;
    coordinateAccuracy: string | null;
    linkedProjects: number;
  };
  canEdit: boolean;
  canPublish: boolean;
  sources: Array<{ id: string; title: string }>;
  markets: Array<{ id: string; name: string; slug: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [lon, setLon] = useState(market.location.lon);
  const [lat, setLat] = useState(market.location.lat);
  const [coordSource, setCoordSource] = useState(market.coordinateSourceId ?? '');
  const [accuracy, setAccuracy] = useState(market.coordinateAccuracy ?? '');
  const [target, setTarget] = useState('');

  if (market.mergedIntoMarketId) return null;
  const s = market.publicationState;
  const editPerm = s === 'published' ? canPublish : canEdit;

  async function run(reason: string) {
    if (!action) return;
    const base = `/api/v1/admin/markets/${market.id}`;
    if (action === 'move') {
      if (!insideNigeria(lon, lat)) throw new Error('Coordinates must fall inside Nigeria.');
      await apiFetch(`${base}/move`, {
        method: 'POST',
        body: {
          location: { lon, lat },
          coordinateSourceId: coordSource || null,
          coordinateAccuracy: accuracy || null,
          expectedVersion: market.version,
          changeReason: reason,
        },
      });
    } else if (action === 'merge') {
      if (!target) throw new Error('Choose the market to merge into.');
      await apiFetch(`${base}/merge`, {
        method: 'POST',
        body: { targetMarketId: target, expectedVersion: market.version, reason },
      });
    } else {
      await apiFetch(`${base}/${action}`, {
        method: 'POST',
        body: { expectedVersion: market.version, reason },
      });
    }
    toast({ title: `${market.name}: ${action} done`, tone: 'success' });
    if (action === 'merge') router.push(`/admin/market-data/markets/${target}`);
    router.refresh();
  }

  const titles: Record<
    Action,
    { title: string; label: string; tone: 'primary' | 'danger'; description: string }
  > = {
    publish: {
      title: 'Publish market',
      label: 'Publish',
      tone: 'primary',
      description:
        'The market becomes visible on the public explorer with whatever evidence is published. Unknown figures stay unknown.',
    },
    unpublish: {
      title: 'Unpublish market',
      label: 'Unpublish',
      tone: 'danger',
      description: 'Removes the market from the public explorer. History and evidence are kept.',
    },
    archive: {
      title: 'Archive market',
      label: 'Archive',
      tone: 'danger',
      description:
        market.linkedProjects > 0
          ? `${market.linkedProjects} linked project(s) keep their references; markets are archived, never deleted.`
          : 'Markets are archived, never deleted, so references stay intact.',
    },
    restore: {
      title: 'Restore market',
      label: 'Restore to draft',
      tone: 'primary',
      description: 'Brings the archived market back as a draft.',
    },
    move: {
      title: 'Move reference point',
      label: 'Move point',
      tone: 'primary',
      description:
        'Coordinates are validated against the Nigeria bounding box and saved as a new revision.',
    },
    merge: {
      title: `Merge ${market.name} into another market`,
      label: 'Merge',
      tone: 'danger',
      description:
        'Interpretations, supplier links, research tasks, properties, projects, requests, flags and neighborhoods are repointed to the target; this market is archived with a pointer to the target. Immutable observations keep their original reference.',
    },
  };
  const meta = action ? titles[action] : null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canPublish && (s === 'draft' || s === 'in_review' || s === 'unpublished') ? (
          <Button size="sm" onClick={() => setAction('publish')}>
            Publish
          </Button>
        ) : null}
        {canPublish && s === 'published' ? (
          <Button size="sm" variant="secondary" onClick={() => setAction('unpublish')}>
            Unpublish
          </Button>
        ) : null}
        {editPerm && s !== 'archived' ? (
          <Button size="sm" variant="secondary" onClick={() => setAction('move')}>
            Move point
          </Button>
        ) : null}
        {editPerm && s !== 'archived' ? (
          <Button size="sm" variant="secondary" onClick={() => setAction('merge')}>
            Merge into…
          </Button>
        ) : null}
        {editPerm && s !== 'archived' ? (
          <Button size="sm" variant="ghost" onClick={() => setAction('archive')}>
            Archive
          </Button>
        ) : null}
        {canEdit && s === 'archived' ? (
          <Button size="sm" onClick={() => setAction('restore')}>
            Restore
          </Button>
        ) : null}
      </div>
      {!canPublish && (s === 'draft' || s === 'in_review') ? (
        <p className="text-xs text-fg-muted">
          Publication needs a data approver with a verified authenticator.
        </p>
      ) : null}
      <ActionDialog
        open={action !== null}
        onOpenChange={(o) => !o && setAction(null)}
        title={meta?.title ?? ''}
        description={meta?.description}
        confirmLabel={meta?.label ?? 'Confirm'}
        tone={meta?.tone ?? 'primary'}
        requireReason
        confirmText={action === 'merge' ? market.name : undefined}
        onConfirm={run}
      >
        {action === 'move' ? (
          <div className="space-y-3">
            <NigeriaPointPicker
              lon={lon}
              lat={lat}
              onChange={(p) => {
                setLon(Number(p.lon.toFixed(4)));
                setLat(Number(p.lat.toFixed(4)));
              }}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Longitude" required>
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    step="0.0001"
                    value={lon}
                    onChange={(e) => setLon(Number(e.target.value))}
                  />
                )}
              </Field>
              <Field label="Latitude" required>
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    step="0.0001"
                    value={lat}
                    onChange={(e) => setLat(Number(e.target.value))}
                  />
                )}
              </Field>
              <Field label="Coordinate source">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={coordSource}
                    onChange={(e) => setCoordSource(e.target.value)}
                  >
                    <option value="">Unspecified</option>
                    {sources.map((src) => (
                      <option key={src.id} value={src.id}>
                        {src.title}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Accuracy note">
                {({ id }) => (
                  <Input id={id} value={accuracy} onChange={(e) => setAccuracy(e.target.value)} />
                )}
              </Field>
            </div>
          </div>
        ) : null}
        {action === 'merge' ? (
          <div className="space-y-3">
            <Alert tone="warning" title="This cannot be undone by a rollback">
              The source market is archived and every reference is repointed. Choose the surviving
              market carefully.
            </Alert>
            <Field label="Merge into" required>
              {({ id }) => (
                <NativeSelect id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose the surviving market</option>
                  {markets.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.slug})
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
        ) : null}
      </ActionDialog>
    </>
  );
}
