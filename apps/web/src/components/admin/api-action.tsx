'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, Button, useToast, type ButtonProps } from '@simplexd/ui';
import { ActionDialog } from '@/app/(admin)/admin/_components/action-dialog';
import { adminFetch, errorMessage, isMfaError } from '@/lib/admin/client';
import { fillTemplate } from '@/lib/admin/form-body';

export interface ApiActionProps {
  path: string;
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Static body, or (client components only) a function of the dialog reason. */
  body?: Record<string, unknown> | ((reason: string) => unknown);
  /**
   * Declarative alternative to a body function for server pages: the typed
   * reason is sent under this key (omitted when left empty).
   */
  reasonKey?: string;
  label: ReactNode;
  /** When present the action opens a confirmation dialog first. */
  confirm?: {
    title: ReactNode;
    description?: ReactNode;
    confirmLabel?: string;
    requireReason?: boolean;
    reasonLabel?: string;
    confirmText?: string;
    tone?: 'primary' | 'danger';
    children?: ReactNode;
  };
  idempotent?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
  /** Explains why the button is disabled (rendered as a title and visually hidden text). */
  disabledReason?: string;
  successMessage?: string;
  /** Navigate after success: a template such as `/admin/x/{id}` filled from the result, or a function (client only). */
  redirectTo?: string | ((result: unknown) => string);
  onSuccess?: (result: unknown) => void;
  className?: string;
}

/**
 * One-click server mutation with optional confirmation/reason dialog, toast,
 * inline error and router refresh. MFA refusals are explained with a link to
 * the authenticator page rather than a bare error.
 */
export function ApiAction({
  path,
  method = 'POST',
  body,
  reasonKey,
  label,
  confirm,
  idempotent,
  variant = 'secondary',
  size = 'sm',
  disabled,
  disabledReason,
  successMessage,
  redirectTo,
  onSuccess,
  className,
}: ApiActionProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  async function run(reason: string) {
    const payload =
      typeof body === 'function'
        ? body(reason)
        : reasonKey
          ? { ...(body ?? {}), ...(reason ? { [reasonKey]: reason } : {}) }
          : body;
    const result = await adminFetch<unknown>(path, { method, body: payload ?? {}, idempotent });
    if (successMessage) toast({ title: successMessage, tone: 'success' });
    onSuccess?.(result);
    if (redirectTo) {
      router.push(typeof redirectTo === 'function' ? redirectTo(result) : fillTemplate(redirectTo, result));
    }
    router.refresh();
  }

  async function direct() {
    setBusy(true);
    setError(null);
    setMfa(false);
    try {
      await run('');
    } catch (err) {
      if (isMfaError(err)) setMfa(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isDisabled = disabled || busy;
  return (
    <span className={className}>
      <Button
        variant={variant}
        size={size}
        disabled={isDisabled}
        loading={busy}
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-disabled={isDisabled || undefined}
        onClick={() => (confirm ? setOpen(true) : void direct())}
      >
        {label}
      </Button>
      {disabled && disabledReason ? <span className="sr-only">{disabledReason}</span> : null}
      {error ? (
        <Alert tone="danger" title={mfa ? 'Authenticator required' : 'Action failed'} className="mt-2">
          {error}
          {mfa ? (
            <>
              {' '}
              <a href="/admin/security/mfa" className="font-medium underline">
                Enrol or verify your authenticator
              </a>
              .
            </>
          ) : null}
        </Alert>
      ) : null}
      {confirm ? (
        <ActionDialog
          open={open}
          onOpenChange={setOpen}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel ?? 'Confirm'}
          tone={confirm.tone ?? 'primary'}
          requireReason={confirm.requireReason}
          reasonLabel={confirm.reasonLabel}
          confirmText={confirm.confirmText}
          onConfirm={run}
        >
          {confirm.children}
        </ActionDialog>
      ) : null}
    </span>
  );
}
