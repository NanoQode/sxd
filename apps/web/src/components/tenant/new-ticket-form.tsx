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
import { uploadFile, validateForPurpose } from '@/lib/portal/upload';
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
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const MAX_PHOTOS = 5;

  function addPhotos(list: FileList | null) {
    if (!list) return;
    const next = [...photos];
    for (const file of Array.from(list)) {
      const problem = validateForPurpose(file, 'maintenance_photo');
      if (problem) {
        setPhotoError(problem);
        continue;
      }
      if (next.length >= MAX_PHOTOS) {
        setPhotoError(`Attach up to ${MAX_PHOTOS} photos.`);
        break;
      }
      next.push(file);
    }
    setPhotos(next);
  }

  /**
   * Uploads the chosen photos and attaches them to the new ticket. The ticket
   * already exists at this point, so a photo failure never loses the request;
   * the person is told which photos did not attach.
   */
  async function attachPhotos(ticketId: string): Promise<number> {
    const fileIds: string[] = [];
    let failed = 0;
    for (const photo of photos) {
      try {
        const res = await uploadFile(photo, { purpose: 'maintenance_photo' });
        if (res.outcome === 'rejected') failed += 1;
        else fileIds.push(res.file.id);
      } catch {
        failed += 1;
      }
    }
    if (fileIds.length > 0) {
      try {
        await tenantFetch(`/api/v1/work-orders/${ticketId}/evidence`, { body: { fileIds } });
      } catch {
        failed += fileIds.length;
      }
    }
    return failed;
  }

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
      const failedPhotos = photos.length > 0 ? await attachPhotos(created.id) : 0;
      toast({
        title: 'Maintenance request sent',
        description:
          failedPhotos > 0
            ? `${failedPhotos} photo(s) could not be attached. The request was sent; describe the problem in a message if needed.`
            : 'The maintenance team will review it. Track progress on the ticket page.',
        tone: failedPhotos > 0 ? 'info' : 'success',
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

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Photos (optional)</legend>
        <p id="ticket-photos-help" className="text-xs text-fg-muted">
          Up to {MAX_PHOTOS} photos of the problem (JPEG, PNG, WebP or HEIC, 25 MB each). They are
          scanned before anyone opens them and shared only with the property team and the assigned
          contractor.
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-primary">
          <Camera aria-hidden="true" className="h-4 w-4" />
          <span>Add photos</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            aria-describedby="ticket-photos-help"
            disabled={busy || photos.length >= MAX_PHOTOS}
            onChange={(e) => {
              setPhotoError(null);
              addPhotos(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {photoError ? (
          <p role="alert" className="text-sm text-danger">
            {photoError}
          </p>
        ) : null}
        {photos.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {photos.map((photo, index) => (
              <li
                key={`${photo.name}-${index}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{photo.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setPhotos((list) => list.filter((_, i) => i !== index))}
                  aria-label={`Remove ${photo.name}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>

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
