'use client';

import { Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { WorkOrderDto } from '@simplexd/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { koboToNaira, koboToNairaInput, nairaInputToKobo } from '@/lib/portal/format';
import { ErrorState } from './error-state';

export const WORK_ORDER_CATEGORIES = [
  'plumbing',
  'electrical',
  'roofing',
  'structural',
  'doors_windows',
  'appliances',
  'security',
  'cleaning',
  'pest_control',
  'other',
] as const;

const PRIORITIES = [
  { value: 'low', label: 'Low: when convenient' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High: affects use of the space' },
  { value: 'urgent', label: 'Urgent: safety or serious damage' },
] as const;

type ErrorInfo = { message: string; correlationId: string | null };

function label(value: string): string {
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Owner raises a maintenance request (work order) on a property, optionally for one unit. */
export function NewWorkOrderButton({
  propertyId,
  units,
  canRequest,
  cannotRequestReason,
}: {
  propertyId: string;
  units: Array<{ id: string; label: string }>;
  canRequest: boolean;
  cannotRequestReason?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [priority, setPriority] = useState<string>('normal');
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);

  if (!canRequest) {
    return (
      <p className="text-sm text-fg-muted">
        {cannotRequestReason ?? 'Requesting maintenance needs an owner of this organisation.'}
      </p>
    );
  }

  async function submit() {
    if (title.trim().length < 3) {
      setError({ message: 'Give the request a short title (3+ characters).', correlationId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch<WorkOrderDto>('/api/v1/work-orders', {
        body: {
          propertyId,
          ...(unitId ? { unitId } : {}),
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          category,
          priority,
        },
      });
      toast({
        title: 'Maintenance requested',
        description: 'The team triages it and sends any cost estimate for your approval.',
        tone: 'success',
      });
      setOpen(false);
      setTitle('');
      setDescription('');
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Wrench aria-hidden="true" className="h-4 w-4" />
        Request maintenance
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent
          title="Request maintenance"
          description="The team triages the request, dispatches a contractor and asks for your approval before any cost is incurred."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            {error ? (
              <ErrorState
                title="Could not create the request"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field label="Title" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  minLength={3}
                  maxLength={200}
                  required
                />
              )}
            </Field>
            <Field label="What is wrong" hint="Where it is, since when, anything already tried.">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={3}
                  maxLength={4000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {WORK_ORDER_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {label(c)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Priority" hint="Sets the response deadline.">
                {({ id, describedBy }) => (
                  <NativeSelect
                    id={id}
                    aria-describedby={describedBy}
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            {units.length > 0 ? (
              <Field label="Unit">
                {({ id }) => (
                  <NativeSelect id={id} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                    <option value="">Whole property / common areas</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} loadingLabel="Sending">
                Send request
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ActionKind = 'approve' | 'reject' | 'verify' | 'cancel';

const CANCELLABLE = new Set(['requested', 'triaged', 'assigned', 'awaiting_approval']);

/** Which owner actions a work order offers, given its state and the caller's rights. */
export function workOrderActionsFor(
  workOrder: Pick<WorkOrderDto, 'status'>,
  rights: { canApprove: boolean; canRequest: boolean },
): ActionKind[] {
  const actions: ActionKind[] = [];
  if (workOrder.status === 'awaiting_approval' && rights.canApprove)
    actions.push('approve', 'reject');
  if (workOrder.status === 'completed' && (rights.canApprove || rights.canRequest))
    actions.push('verify');
  if (CANCELLABLE.has(workOrder.status) && rights.canRequest) actions.push('cancel');
  return actions;
}

/** What happens next when the owner has nothing to decide, so the row never shows a blank. */
export function workOrderNextStep(status: WorkOrderDto['status']): string {
  switch (status) {
    case 'requested':
      return 'Waiting for the team to triage.';
    case 'triaged':
    case 'assigned':
      return 'The team is arranging a contractor.';
    case 'awaiting_approval':
      return 'Waiting for an approver in your organisation.';
    case 'approved':
      return 'Approved; the contractor proceeds.';
    case 'in_progress':
      return 'Work in progress.';
    case 'completed':
      return 'Completed; waiting for verification.';
    case 'verified':
      return 'Verified; the cost is on your statement.';
    default:
      return 'No action needed.';
  }
}

/**
 * Owner decisions on a work order: approve or reject the contractor's
 * estimate, verify completed work (which records the recoverable expense),
 * or cancel a request that has not started. Each call carries the version
 * the owner saw, so a stale page is refused instead of overwriting.
 */
export function WorkOrderActions({
  workOrder,
  canApprove,
  canRequest,
}: {
  workOrder: Pick<
    WorkOrderDto,
    'id' | 'title' | 'status' | 'version' | 'estimateKobo' | 'approvedAmountKobo' | 'actualCostKobo'
  >;
  canApprove: boolean;
  canRequest: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<ActionKind | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const actions = workOrderActionsFor(workOrder, { canApprove, canRequest });

  if (actions.length === 0)
    return <span className="text-xs text-fg-muted">{workOrderNextStep(workOrder.status)}</span>;

  function open(next: ActionKind) {
    setError(null);
    setReason('');
    setAmount(
      next === 'approve'
        ? koboToNairaInput(workOrder.estimateKobo)
        : next === 'verify'
          ? koboToNairaInput(workOrder.actualCostKobo ?? workOrder.approvedAmountKobo)
          : '',
    );
    setMode(next);
  }

  async function submit() {
    if (!mode) return;
    let path = '';
    let body: Record<string, unknown> = { expectedVersion: workOrder.version };
    if (mode === 'approve') {
      const kobo = nairaInputToKobo(amount);
      if (!kobo || kobo === '0') {
        setError({ message: 'Enter the amount you approve, in naira.', correlationId: null });
        return;
      }
      path = 'approve';
      body = { ...body, approvedAmountKobo: kobo };
    } else if (mode === 'verify') {
      const kobo = amount.trim() ? nairaInputToKobo(amount) : null;
      if (amount.trim() && !kobo) {
        setError({
          message: 'Enter the final cost in naira, or leave it empty.',
          correlationId: null,
        });
        return;
      }
      path = 'verify';
      body = { ...body, ...(kobo ? { costKobo: kobo } : {}) };
    } else {
      if (reason.trim().length < 3) {
        setError({ message: 'Give a short reason (3+ characters).', correlationId: null });
        return;
      }
      path = mode;
      body = { ...body, reason: reason.trim() };
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch<WorkOrderDto>(`/api/v1/work-orders/${workOrder.id}/${path}`, { body });
      toast({ title: SUCCESS[mode], tone: 'success' });
      setMode(null);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  const dialog: Record<ActionKind, { title: string; description: string; confirm: string }> = {
    approve: {
      title: `Approve the cost of “${workOrder.title}”`,
      description: workOrder.estimateKobo
        ? `The contractor estimated ${koboToNaira(workOrder.estimateKobo)}. Approving authorises work up to the amount below.`
        : 'Approving authorises work up to the amount below.',
      confirm: 'Approve cost',
    },
    reject: {
      title: `Reject the estimate for “${workOrder.title}”`,
      description: 'The team is told why and can send a revised estimate.',
      confirm: 'Reject estimate',
    },
    verify: {
      title: `Verify “${workOrder.title}” is done`,
      description:
        'Confirms the work was completed to your satisfaction and records the cost as a recoverable property expense on your statement.',
      confirm: 'Verify completed work',
    },
    cancel: {
      title: `Cancel “${workOrder.title}”`,
      description: 'The request is closed and the team is notified.',
      confirm: 'Cancel request',
    },
  };

  let fields: ReactNode = null;
  if (mode === 'approve' || mode === 'verify') {
    fields = (
      <Field
        label={mode === 'approve' ? 'Approved amount (₦)' : 'Final cost (₦)'}
        required={mode === 'approve'}
        hint={
          mode === 'verify'
            ? 'Leave as is to record the contractor’s actual cost, or the approved amount.'
            : undefined
        }
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required={mode === 'approve'}
          />
        )}
      </Field>
    );
  } else if (mode === 'reject' || mode === 'cancel') {
    fields = (
      <Field label="Reason" required>
        {({ id }) => (
          <Textarea
            id={id}
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        )}
      </Field>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => (
        <Button
          key={a}
          type="button"
          size="sm"
          variant={
            a === 'approve' || a === 'verify' ? 'primary' : a === 'cancel' ? 'ghost' : 'secondary'
          }
          onClick={() => open(a)}
        >
          {BUTTON[a]}
        </Button>
      ))}
      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        {mode ? (
          <DialogContent
            title={dialog[mode].title}
            description={dialog[mode].description}
            size="sm"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="space-y-4"
            >
              {error ? (
                <ErrorState
                  title="Could not record the decision"
                  message={error.message}
                  correlationId={error.correlationId}
                />
              ) : null}
              {fields}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setMode(null)} disabled={busy}>
                  Back
                </Button>
                <Button
                  type="submit"
                  variant={mode === 'reject' || mode === 'cancel' ? 'danger' : 'primary'}
                  loading={busy}
                >
                  {dialog[mode].confirm}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

const BUTTON: Record<ActionKind, string> = {
  approve: 'Approve cost',
  reject: 'Reject estimate',
  verify: 'Verify work',
  cancel: 'Cancel request',
};

const SUCCESS: Record<ActionKind, string> = {
  approve: 'Cost approved',
  reject: 'Estimate rejected',
  verify: 'Work verified',
  cancel: 'Request cancelled',
};
