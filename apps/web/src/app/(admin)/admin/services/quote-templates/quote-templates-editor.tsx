'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
  type Column,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { koboToNairaInput } from '@/lib/admin/money';
import { Money } from '@/components/admin/money';
import type { QuoteTemplateDto } from '@/server/admin/configuration/quote-templates';
import type { ServiceOption } from '@/server/admin/configuration/shared';
import { fmtDate } from '../../_components/bits';
import { EMPTY_LINE, LinesEditor, parseLines, type DraftLine } from '../_components/lines-editor';

const ALL = '__all__';

export function QuoteTemplatesEditor({
  items,
  services,
  canManage,
}: {
  items: QuoteTemplateDto[];
  services: ServiceOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<QuoteTemplateDto | 'new' | null>(null);
  const [name, setName] = useState('');
  const [serviceId, setServiceId] = useState(ALL);
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [scope, setScope] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(t: QuoteTemplateDto | 'new') {
    setEditing(t);
    setError(null);
    setReason('');
    if (t === 'new') {
      setName('');
      setServiceId(ALL);
      setLines([{ ...EMPTY_LINE }]);
      setScope('');
      setExclusions('');
      setActive(true);
    } else {
      setName(t.name);
      setServiceId(t.serviceId ?? ALL);
      setLines(
        t.lines.length > 0
          ? t.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitNaira: koboToNairaInput(l.unitAmountKobo),
            }))
          : [{ ...EMPTY_LINE }],
      );
      setScope(t.scopeMarkdown ?? '');
      setExclusions(t.exclusions ?? '');
      setActive(t.active);
    }
  }

  const parsed = parseLines(lines);
  const ready =
    name.trim().length >= 3 && parsed.valid && (editing === 'new' || reason.trim().length >= 3);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      serviceId: serviceId === ALL ? null : serviceId,
      name: name.trim(),
      lines: parsed.lines,
      scopeMarkdown: scope.trim() || null,
      exclusions: exclusions.trim() || null,
      active,
    };
    try {
      if (editing === 'new') {
        await adminFetch('/api/v1/admin/quote-templates', { body });
        toast({ title: 'Template created', tone: 'success' });
      } else if (editing) {
        await adminFetch(`/api/v1/admin/quote-templates/${editing.id}`, {
          method: 'PATCH',
          body: { ...body, reason: reason.trim(), expectedUpdatedAt: editing.updatedAt },
        });
        toast({ title: 'Template updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<QuoteTemplateDto>[] = [
    {
      key: 'name',
      header: 'Template',
      cell: (t) => (
        <span className="font-medium">
          {t.name}
          {!t.active ? (
            <Badge tone="neutral" className="ml-2">
              Inactive
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'service', header: 'Service', cell: (t) => t.serviceName ?? 'All services' },
    { key: 'lines', header: 'Lines', cell: (t) => t.lines.length },
    {
      key: 'subtotal',
      header: 'Subtotal',
      cell: (t) => <Money kobo={t.subtotalKobo} />,
      className: 'text-right',
    },
    {
      key: 'updated',
      header: 'Updated',
      hideOnMobile: true,
      cell: (t) => <span className="text-xs">{fmtDate(t.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (t) =>
        canManage ? (
          <Button size="sm" variant="secondary" onClick={() => open(t)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => open('new')}>New template</Button>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(t) => t.id}
        rowLabel={(t) => t.name}
        caption="Quotation templates"
        emptyMessage="No quotation templates yet. Staff can still draft quotes line by line."
      />
      <Dialog open={editing !== null} onOpenChange={(v) => !busy && !v && setEditing(null)}>
        <DialogContent
          className={DIALOG_MAX_H}
          size="lg"
          title={
            editing === 'new'
              ? 'New quotation template'
              : `Edit ${editing === null ? '' : editing.name}`
          }
          description="Amounts are whole naira; line amounts are recomputed on the server."
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
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
              <Field
                label="Applies to"
                hint="A template for all services appears on every request."
              >
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={serviceId}
                    onChange={(e) => setServiceId(e.target.value)}
                  >
                    <option value={ALL}>All services</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            <LinesEditor lines={lines} onChange={setLines} />
            <Field label="Scope (markdown)">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="min-h-20"
                  maxLength={20000}
                />
              )}
            </Field>
            <Field label="Exclusions">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={exclusions}
                  onChange={(e) => setExclusions(e.target.value)}
                  className="min-h-16"
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
              Active (offered when drafting quotes)
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
    </div>
  );
}
