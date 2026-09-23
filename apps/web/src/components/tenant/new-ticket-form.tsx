'use client';

import { Camera } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { WorkOrderDto } from '@simplexd/contracts';
import {
  Button,
  ErrorSummary,
  Field,
  Input,
  NativeSelect,
  Textarea,
  cn,
  useToast,
} from '@simplexd/ui';
import { ErrorState } from '@/components/portal/error-state';
import { describeTenantError, tenantFetch } from '@/lib/tenant/client';
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from '@/lib/tenant/model';

export interface TicketLeaseOption {
  id: string;
  title: string;
}

interface Values {
  leaseId: string;
  category: string;
  priority: string;
  title: string;
  description: string;
}

type FieldErrors = Partial<Record<keyof Values, string>>;

export function validateTicket(values: Values): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.leaseId) errors.leaseId = 'Choose the lease this problem is about.';
  if (!values.category) errors.category = 'Choose what kind of problem it is.';
  const title = values.title.trim();
  if (title.length < 3) errors.title = 'Give the problem a short title (at least 3 characters).';
  else if (title.length > 200) errors.title = 'Keep the title under 200 characters.';
  if (values.description.trim().length > 4000)
    errors.description = 'Keep the description under 4,000 characters.';
  return errors;
}

const FIELD_IDS: Record<keyof Values, string> = {
  leaseId: 'ticket-lease',
  category: 'ticket-category',
  priority: 'ticket-priority-normal',
  title: 'ticket-title',
  description: 'ticket-description',
};

/**
 * Report a maintenance problem on one of the caller's leases. The request
 * is scoped by the server to that lease's property and unit. Input is kept
 * after any failure; a second submit is blocked while one is in flight.
 */
export function NewTicketForm({ leases }: { leases: TicketLeaseOption[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<Values>({
    leaseId: leases.length === 1 ? leases[0]!.id : '',
    category: '',
    priority: 'normal',
    title: '',
    description: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ReturnType<typeof describeTenantError> | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const found = validateTicket(values);
    setErrors(found);
    setFailure(null);
    if (Object.values(found).some(Boolean)) {
      const first = (Object.keys(found) as Array<keyof Values>).find((k) => found[k]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await tenantFetch<WorkOrderDto>(
        `/api/v1/tenant/leases/${values.leaseId}/tickets`,
        {
          body: {
            title: values.title.trim(),
            description: values.description.trim() || null,
            category: values.category,
            priority: values.priority,
          },
        },
      );
      toast({
        title: 'Maintenance request sent',
        description: 'The maintenance team will review it. Track progress on the ticket page.',
        tone: 'success',
      });
      router.push(`/tenant/tickets/${created.id}`);
      router.refresh();
    } catch (err) {
      setFailure(describeTenantError(err));
      setBusy(false);
    }
  }

  const summary = (Object.keys(errors) as Array<keyof Values>)
    .filter((k) => errors[k])
    .map((k) => ({ id: FIELD_IDS[k], message: errors[k]! }));

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-5">
      <ErrorSummary errors={summary} />
      {failure ? (
        <ErrorState
          title={
            failure.code === 'forbidden' || failure.code === 'not_found'
              ? 'You cannot report a problem on this lease'
              : 'Your request was not sent'
          }
          message={`${failure.message} Your answers are still here.`}
          correlationId={failure.correlationId}
        />
      ) : null}

      {leases.length > 1 ? (
        <Field label="Lease" htmlFor={FIELD_IDS.leaseId} error={errors.leaseId} required>
          {({ id, describedBy, invalid }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={values.leaseId}
              onChange={(e) => set('leaseId', e.target.value)}
            >
              <option value="">Choose a lease</option>
              {leases.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : leases[0] ? (
        <p className="text-sm text-fg-muted">
          For <strong className="text-fg">{leases[0].title}</strong>
        </p>
      ) : null}

      <Field
        label="What kind of problem?"
        htmlFor={FIELD_IDS.category}
        error={errors.category}
        required
      >
        {({ id, describedBy, invalid }) => (
          <NativeSelect
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={values.category}
            onChange={(e) => set('category', e.target.value)}
          >
            <option value="">Choose a category</option>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>

      <Field
        label="Short title"
        htmlFor={FIELD_IDS.title}
        error={errors.title}
        hint="For example: Kitchen tap leaking under the sink."
        required
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={values.title}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => set('title', e.target.value)}
          />
        )}
      </Field>

      <Field
        label="Describe the problem"
        htmlFor={FIELD_IDS.description}
        error={errors.description}
        hint="Where it is, when it started, and anything the contractor should know about access."
      >
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={values.description}
            maxLength={4000}
            rows={5}
            onChange={(e) => set('description', e.target.value)}
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How urgent is it?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {TICKET_PRIORITIES.map((p) => {
            const id = `ticket-priority-${p.value}`;
            const checked = values.priority === p.value;
            return (
              <label
                key={p.value}
                htmlFor={id}
                className={cn(
                  'sx-transition flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm',
                  checked ? 'border-primary bg-primary-soft' : 'border-border hover:bg-bg-sunken',
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name="priority"
                  value={p.value}
                  checked={checked}
                  onChange={() => set('priority', p.value)}
                  className="mt-0.5 h-4 w-4 accent-[var(--sx-primary)]"
                />
                <span>
                  <span className="block font-medium">{p.label}</span>
                  <span className="block text-xs text-fg-muted">Target: {p.target}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-fg-muted">
          If there is immediate danger (fire, gas, serious flooding), call the emergency services
          first.
        </p>
      </fieldset>

      <div
        role="note"
        className="flex gap-3 rounded-md border border-dashed border-border bg-bg-sunken p-3 text-sm text-fg-muted"
      >
        <Camera aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <span className="font-medium text-fg">Photo attachments are not available yet.</span> The
          maintenance service only accepts photos from the assigned contractor or staff, so describe
          the problem in words; the contractor photographs it on the visit.
        </p>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/tenant/tickets')}
          disabled={busy}
        >
          Back to tickets
        </Button>
        <Button type="submit" loading={busy} loadingLabel="Sending">
          Send request
        </Button>
      </div>
    </form>
  );
}
