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
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import type { ResearchTaskDto } from '@/server/admin/market-data/research-tasks';
import { humanize } from '../../../_lib/params';

const STATUSES = ['open', 'in_progress', 'in_review', 'done', 'blocked'] as const;
const CATEGORIES = [
  'comparables',
  'supplier_quotes',
  'cost_evidence',
  'approvals',
  'timelines',
  'environmental',
  'other',
] as const;

interface FormState {
  title: string;
  category: string;
  priority: number;
  status: (typeof STATUSES)[number];
  assigneeUserId: string;
  reviewerUserId: string;
  budgetNaira: string;
  dueDate: string;
  evidenceRightsNote: string;
  targetCount: string;
  completedCount: string;
  notes: string;
}

const empty: FormState = {
  title: '',
  category: 'comparables',
  priority: 3,
  status: 'open',
  assigneeUserId: '',
  reviewerUserId: '',
  budgetNaira: '',
  dueDate: '',
  evidenceRightsNote: '',
  targetCount: '',
  completedCount: '0',
  notes: '',
};

export function ResearchTasksTab({
  marketId,
  items,
  staff,
  canEdit,
}: {
  marketId: string;
  items: ResearchTaskDto[];
  staff: Array<{ id: string; name: string; email: string; roles: string[] }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<ResearchTaskDto | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(t: ResearchTaskDto | 'new') {
    setEditing(t);
    setError(null);
    setForm(
      t === 'new'
        ? empty
        : {
            title: t.title,
            category: t.category,
            priority: t.priority,
            status: t.status,
            assigneeUserId: t.assigneeUserId ?? '',
            reviewerUserId: t.reviewerUserId ?? '',
            budgetNaira: t.budgetNaira === null ? '' : String(t.budgetNaira),
            dueDate: t.dueDate ?? '',
            evidenceRightsNote: t.evidenceRightsNote ?? '',
            targetCount: t.targetCount === null ? '' : String(t.targetCount),
            completedCount: String(t.completedCount),
            notes: t.notes ?? '',
          },
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: form.title.trim(),
        category: form.category,
        priority: Number(form.priority),
        assigneeUserId: form.assigneeUserId || null,
        reviewerUserId: form.reviewerUserId || null,
        budgetNaira: form.budgetNaira === '' ? null : Number(form.budgetNaira),
        dueDate: form.dueDate || null,
        evidenceRightsNote: form.evidenceRightsNote || null,
        targetCount: form.targetCount === '' ? null : Number(form.targetCount),
        notes: form.notes || null,
      };
      if (editing === 'new') {
        await apiFetch(`/api/v1/admin/markets/${marketId}/research-tasks`, { body });
        toast({ title: 'Research task created', tone: 'success' });
      } else if (editing) {
        await apiFetch(`/api/v1/admin/markets/${marketId}/research-tasks/${editing.id}`, {
          method: 'PATCH',
          body: {
            ...body,
            status: form.status,
            completedCount: Number(form.completedCount) || 0,
            expectedUpdatedAt: editing.updatedAt,
          },
        });
        toast({ title: 'Research task updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<ResearchTaskDto>[] = [
    {
      key: 'title',
      header: 'Task',
      cell: (t) => (
        <span className="font-medium">
          {t.title}
          <span className="block text-xs text-fg-muted">
            {humanize(t.category)} · priority {t.priority}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => (
        <Badge
          tone={
            t.status === 'done'
              ? 'success'
              : t.status === 'blocked'
                ? 'danger'
                : t.status === 'open'
                  ? 'neutral'
                  : 'info'
          }
        >
          {humanize(t.status)}
        </Badge>
      ),
    },
    {
      key: 'people',
      header: 'Researcher / reviewer',
      cell: (t) => (
        <span className="text-xs">
          {t.assigneeName ?? '—'}
          <span className="block text-fg-muted">reviewed by {t.reviewerName ?? '—'}</span>
        </span>
      ),
    },
    { key: 'due', header: 'Due', cell: (t) => t.dueDate ?? '—' },
    {
      key: 'budget',
      header: 'Budget',
      hideOnMobile: true,
      cell: (t) => (t.budgetNaira === null ? '—' : `₦${t.budgetNaira.toLocaleString('en-NG')}`),
    },
    {
      key: 'progress',
      header: 'Progress',
      cell: (t) =>
        t.targetCount ? `${t.completedCount}/${t.targetCount}` : String(t.completedCount),
    },
    {
      key: 'rights',
      header: 'Evidence rights',
      hideOnMobile: true,
      cell: (t) => <span className="text-xs text-fg-muted">{t.evidenceRightsNote ?? '—'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (t) =>
        canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => open(t)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Research queue">
        Obtain local comparables (target ten or more deduplicated), current delivered supplier
        quotes, architect or quantity-surveyor estimates, approval-authority evidence and site-level
        environmental checks. Never scrape prohibited sources or republish contact details without a
        lawful purpose.
      </Alert>
      <div className="flex justify-end">
        {canEdit ? (
          <Button size="sm" onClick={() => open('new')}>
            Add task
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(t) => t.id}
        rowLabel={(t) => t.title}
        caption="Research tasks"
        emptyMessage="No research tasks."
      />

      <Dialog open={editing !== null} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent
          title={editing === 'new' ? 'Add research task' : 'Edit research task'}
          size="lg"
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            <Field label="Title" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                />
              )}
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Category">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={form.category}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Priority (1 = highest)">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={5}
                    value={form.priority}
                    onChange={(e) => setForm((f) => ({ ...f, priority: Number(e.target.value) }))}
                  />
                )}
              </Field>
              <Field label="Researcher">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={form.assigneeUserId}
                    onChange={(e) => setForm((f) => ({ ...f, assigneeUserId: e.target.value }))}
                  >
                    <option value="">Unassigned</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.roles.join(', ')})
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Reviewer (must differ)">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={form.reviewerUserId}
                    onChange={(e) => setForm((f) => ({ ...f, reviewerUserId: e.target.value }))}
                  >
                    <option value="">Unassigned</option>
                    {staff
                      .filter((s) => s.id !== form.assigneeUserId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.roles.join(', ')})
                        </option>
                      ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Budget (₦)">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={form.budgetNaira}
                    onChange={(e) => setForm((f) => ({ ...f, budgetNaira: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Due date">
                {({ id }) => (
                  <Input
                    id={id}
                    type="date"
                    value={form.dueDate}
                    onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Target count" hint="e.g. 10 comparables">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={form.targetCount}
                    onChange={(e) => setForm((f) => ({ ...f, targetCount: e.target.value }))}
                  />
                )}
              </Field>
              {editing !== 'new' ? (
                <>
                  <Field label="Completed count">
                    {({ id }) => (
                      <Input
                        id={id}
                        type="number"
                        min={0}
                        value={form.completedCount}
                        onChange={(e) => setForm((f) => ({ ...f, completedCount: e.target.value }))}
                      />
                    )}
                  </Field>
                  <Field label="Status">
                    {({ id }) => (
                      <NativeSelect
                        id={id}
                        value={form.status}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, status: e.target.value as FormState['status'] }))
                        }
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                </>
              ) : null}
            </div>
            <Field
              label="Evidence rights note"
              hint="Licensing, permission and republication limits for what will be collected."
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  className="min-h-20"
                  value={form.evidenceRightsNote}
                  onChange={(e) => setForm((f) => ({ ...f, evidenceRightsNote: e.target.value }))}
                />
              )}
            </Field>
            <Field label="Notes">
              {({ id }) => (
                <Textarea
                  id={id}
                  className="min-h-20"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
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
                disabled={form.title.trim().length < 3}
              >
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
