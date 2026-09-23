'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, NativeSelect, Textarea, useToast, type ButtonProps } from '@simplexd/ui';
import { adminFetch, errorMessage, isMfaError } from '@/lib/admin/client';
import { FORM_TRANSFORMS, buildBody, fillTemplate, type BodyFieldSpec, type FormTransformName, type FormValues } from '@/lib/admin/form-body';
import { parseNairaToKobo } from '@/lib/admin/money';

export type { FormValues };

export type FieldSpec = BodyFieldSpec & {
  label: string;
  type?: 'text' | 'number' | 'date' | 'datetime' | 'textarea' | 'select' | 'checkbox' | 'naira';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  /** Full-width in the two-column grid. */
  wide?: boolean;
};

/**
 * Declarative create/edit dialog: renders labelled fields, validates required
 * ones client-side, posts the mapped body and refreshes. Naira fields are
 * converted to integer kobo strings; datetime fields to ISO instants.
 *
 * Server pages describe the body with field `bodyKey`/`emptyAs`/`list`, a
 * static `extraBody` and, for special cases, a named `transform`; client
 * components may pass `toBody` directly (functions cannot cross from a server
 * component).
 */
export function FormDialog({
  trigger,
  title,
  description,
  fields,
  path,
  method = 'POST',
  toBody,
  transform,
  extraBody,
  idempotent,
  submitLabel = 'Save',
  successMessage,
  variant = 'secondary',
  size = 'sm',
  disabled,
  disabledReason,
  redirectTo,
  children,
}: {
  trigger: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  fields: FieldSpec[];
  path: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  /** Client components only: maps form values to the request body. */
  toBody?: (values: FormValues) => unknown;
  /** Named transform from FORM_TRANSFORMS; receives the values and `extraBody`. */
  transform?: FormTransformName;
  /** Static body fields (dotted keys allowed) merged after the field values. */
  extraBody?: Record<string, unknown>;
  idempotent?: boolean;
  submitLabel?: string;
  successMessage?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
  disabledReason?: string;
  /** Template such as `/admin/reports/{id}` filled from the API result, or a function (client only). */
  redirectTo?: string | ((result: unknown) => string);
  children?: ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initial(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  function set(name: string, v: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  const invalid = fields.filter((f) => f.required && !values[f.name] && f.type !== 'checkbox');
  const badMoney = fields.filter((f) => f.type === 'naira' && values[f.name] && parseNairaToKobo(String(values[f.name])) === null);

  async function submit() {
    setBusy(true);
    setError(null);
    setMfa(false);
    try {
      const normalised: FormValues = {};
      for (const f of fields) {
        const raw = values[f.name];
        if (f.type === 'checkbox') normalised[f.name] = Boolean(raw);
        else if (raw === '' || raw === undefined) normalised[f.name] = undefined;
        else if (f.type === 'number') normalised[f.name] = Number(raw);
        else if (f.type === 'naira') normalised[f.name] = parseNairaToKobo(String(raw));
        else if (f.type === 'datetime') normalised[f.name] = new Date(String(raw)).toISOString();
        else normalised[f.name] = String(raw).trim();
      }
      const body = toBody
        ? toBody(normalised)
        : transform
          ? FORM_TRANSFORMS[transform](normalised, extraBody ?? {})
          : buildBody(fields, normalised, extraBody);
      const result = await adminFetch<unknown>(path, { method, body, idempotent });
      if (successMessage) toast({ title: successMessage, tone: 'success' });
      setOpen(false);
      setValues(initial(fields));
      if (redirectTo) router.push(typeof redirectTo === 'function' ? redirectTo(result) : fillTemplate(redirectTo, result));
      router.refresh();
    } catch (err) {
      if (isMfaError(err)) setMfa(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} size={size} disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => setOpen(true)}>
        {trigger}
      </Button>
      {disabled && disabledReason ? <span className="sr-only">{disabledReason}</span> : null}
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent title={title} description={description} size="lg">
          <div className="grid gap-3 sm:grid-cols-2">
            {error ? (
              <div className="sm:col-span-2">
                <Alert tone="danger" title={mfa ? 'Authenticator required' : 'Could not save'}>
                  {error}
                  {mfa ? (
                    <>
                      {' '}
                      <a href="/admin/security/mfa" className="font-medium underline">
                        Verify your authenticator
                      </a>
                      .
                    </>
                  ) : null}
                </Alert>
              </div>
            ) : null}
            {children ? <div className="sm:col-span-2">{children}</div> : null}
            {fields.map((f) => (
              <div key={f.name} className={f.wide || f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
                {f.type === 'checkbox' ? (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />
                    {f.label}
                    {f.hint ? <span className="text-fg-muted">— {f.hint}</span> : null}
                  </label>
                ) : (
                  <Field label={f.label} required={f.required} hint={f.hint} error={f.type === 'naira' && badMoney.includes(f) ? 'Enter a naira amount such as 250000 or 1,250.50' : undefined}>
                    {({ id, describedBy, invalid: isInvalid }) =>
                      f.type === 'textarea' ? (
                        <Textarea id={id} aria-describedby={describedBy} aria-invalid={isInvalid} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} className="min-h-20" />
                      ) : f.type === 'select' ? (
                        <NativeSelect id={id} aria-describedby={describedBy} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
                          {!f.required ? <option value="">—</option> : null}
                          {(f.options ?? []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Input
                          id={id}
                          aria-describedby={describedBy}
                          aria-invalid={isInvalid}
                          type={f.type === 'datetime' ? 'datetime-local' : f.type === 'naira' ? 'text' : (f.type ?? 'text')}
                          inputMode={f.type === 'naira' ? 'decimal' : undefined}
                          min={f.min}
                          max={f.max}
                          value={String(values[f.name] ?? '')}
                          placeholder={f.placeholder}
                          onChange={(e) => set(f.name, e.target.value)}
                        />
                      )
                    }
                  </Field>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button loading={busy} disabled={invalid.length > 0 || badMoney.length > 0} onClick={() => void submit()}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function initial(fields: FieldSpec[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    if (f.type === 'checkbox') out[f.name] = Boolean(f.defaultValue);
    else if (f.defaultValue !== undefined) out[f.name] = String(f.defaultValue);
    else if (f.type === 'select' && f.required) out[f.name] = f.options?.[0]?.value ?? '';
    else out[f.name] = '';
  }
  return out;
}
