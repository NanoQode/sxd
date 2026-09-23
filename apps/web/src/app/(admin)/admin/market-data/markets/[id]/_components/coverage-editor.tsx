'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Input, NativeSelect, useToast } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import type { CoverageRowDto } from '@/server/admin/market-data/coverage';
import { ActionDialog } from '../../../../_components/action-dialog';
import { AVAILABILITY, humanize } from '../../../_lib/params';

type Availability = (typeof AVAILABILITY)[number];

/** Per-service availability editor; writes service_coverage independently of map publication. */
export function CoverageEditor({
  marketId,
  rows,
  canEdit,
}: {
  marketId: string;
  rows: CoverageRowDto[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState<
    Record<string, { availability: Availability | ''; note: string }>
  >(() =>
    Object.fromEntries(
      rows.map((r) => [r.serviceId, { availability: r.availability ?? '', note: r.note ?? '' }]),
    ),
  );
  const [confirm, setConfirm] = useState(false);

  const changed = rows.filter((r) => {
    const d = draft[r.serviceId];
    return d && ((d.availability || '') !== (r.availability ?? '') || d.note !== (r.note ?? ''));
  });

  async function save(reason: string) {
    const items = changed
      .filter((r) => draft[r.serviceId]?.availability)
      .map((r) => ({
        serviceId: r.serviceId,
        availability: draft[r.serviceId]!.availability as Availability,
        note: draft[r.serviceId]!.note || null,
      }));
    if (items.length === 0) throw new Error('Choose an availability for the changed services.');
    await apiFetch(`/api/v1/admin/markets/${marketId}/coverage`, {
      method: 'PUT',
      body: { items, reason },
    });
    toast({ title: 'Service coverage saved', tone: 'success' });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Availability is an operations decision">
        Map publication says where SimplexD has data; service coverage says where SimplexD can
        actually deliver each service. Unstaffed services stay unavailable for booking.
      </Alert>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Service availability</caption>
          <thead className="bg-bg-sunken text-left text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Service
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Availability
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Note
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.serviceId} className="border-t border-border">
                <td className="px-3 py-2 align-top">
                  <span className="font-medium">{r.serviceName}</span>
                  <span className="block text-xs text-fg-muted">
                    {r.category === 'core' ? 'Core service' : 'Expansion (flag-gated)'} ·{' '}
                    {humanize(r.servicePublicationState)}
                  </span>
                </td>
                <td className="px-3 py-2 align-top">
                  {canEdit ? (
                    <NativeSelect
                      aria-label={`${r.serviceName} availability`}
                      value={draft[r.serviceId]?.availability ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [r.serviceId]: {
                            availability: e.target.value as Availability | '',
                            note: d[r.serviceId]?.note ?? '',
                          },
                        }))
                      }
                    >
                      <option value="">Not set</option>
                      {AVAILABILITY.map((a) => (
                        <option key={a} value={a}>
                          {humanize(a)}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Badge tone={r.availability === 'available' ? 'success' : 'neutral'}>
                      {r.availability ? humanize(r.availability) : 'Not set'}
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  {canEdit ? (
                    <Input
                      aria-label={`${r.serviceName} note`}
                      value={draft[r.serviceId]?.note ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [r.serviceId]: {
                            availability: d[r.serviceId]?.availability ?? '',
                            note: e.target.value,
                          },
                        }))
                      }
                    />
                  ) : (
                    <span className="text-fg-muted">{r.note ?? '—'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button disabled={changed.length === 0} onClick={() => setConfirm(true)}>
            Save{' '}
            {changed.length > 0
              ? `${changed.length} change${changed.length === 1 ? '' : 's'}`
              : 'changes'}
          </Button>
          <span className="text-xs text-fg-muted">
            Recorded with a reason; published markets update the public site immediately.
          </span>
        </div>
      ) : null}
      <ActionDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Save service coverage"
        confirmLabel="Save"
        requireReason
        onConfirm={save}
      >
        <ul className="text-sm text-fg-muted">
          {changed.map((r) => (
            <li key={r.serviceId}>
              {r.serviceName}: {humanize(r.availability ?? 'not set')} →{' '}
              {humanize(draft[r.serviceId]?.availability || 'not set')}
            </li>
          ))}
        </ul>
      </ActionDialog>
    </div>
  );
}
