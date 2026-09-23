'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import type {
  IntegrationCheckResult,
  IntegrationConfigDto,
  IntegrationDetailResponse,
  IntegrationEnvironment,
  IntegrationFieldDescriptor,
  IntegrationLogDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  ErrorSummary,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Switch,
  Textarea,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../_components/action-dialog';
import { fmtDate, JsonBlock, Mono } from '../../_components/bits';
import { statusLabel } from '../labels';

/**
 * Provider configuration panel. Three explicit, separate actions:
 * Save (new version, unverified) → Test connection (real adapter result) →
 * Activate (only after a passed test, or forced with an audited reason).
 * Secret inputs are write-only: the page only ever receives presence and
 * fingerprint, never a value.
 */

type FormValues = Record<string, unknown>;

interface Permissions {
  manage: boolean;
  test: boolean;
  rotate: boolean;
  paymentCredentials: boolean;
  mfaVerified: boolean;
}

function fieldSchema(f: IntegrationFieldDescriptor): z.ZodTypeAny {
  const empty = (v: unknown) => (v === '' || v === null ? undefined : v);
  switch (f.kind) {
    case 'boolean':
      return z.boolean().default(false);
    case 'integer': {
      let n = z.coerce.number().int();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      return f.required ? z.preprocess(empty, n) : z.preprocess(empty, n.optional());
    }
    case 'enum': {
      const e = z.enum((f.options ?? ['']) as [string, ...string[]]);
      return f.required ? e : z.preprocess(empty, e.optional());
    }
    case 'string_list':
      return z.array(z.string().min(1)).default([]);
    case 'email': {
      const e = z.string().trim().email('must be an email address');
      return f.required ? e : z.preprocess(empty, e.optional());
    }
    case 'url': {
      const u = z.string().trim().url('must be an absolute URL');
      return f.required ? u : z.preprocess(empty, u.optional());
    }
    default: {
      const s = z.string().trim();
      return f.required ? s.min(1, 'required') : z.preprocess(empty, s.optional());
    }
  }
}

function buildSchema(fields: IntegrationFieldDescriptor[]): z.ZodType<FormValues, FormValues> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) shape[f.key] = fieldSchema(f);
  return z.object(shape) as unknown as z.ZodType<FormValues, FormValues>;
}

function defaultsFrom(
  fields: IntegrationFieldDescriptor[],
  settings: Record<string, unknown> | undefined,
): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = settings?.[f.key];
    if (f.kind === 'boolean') out[f.key] = typeof v === 'boolean' ? v : false;
    else if (f.kind === 'string_list') out[f.key] = Array.isArray(v) ? v : [];
    else out[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

function ModeBadge({ dto }: { dto: IntegrationConfigDto }) {
  return dto.developmentAdapter ? <Badge tone="warning">development adapter</Badge> : <Badge tone="primary">{dto.adapter}</Badge>;
}

export function ProviderPanel({
  detail,
  logs,
  permissions,
}: {
  detail: IntegrationDetailResponse;
  logs: IntegrationLogDto[];
  permissions: Permissions;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { descriptor } = detail;
  const [environment, setEnvironment] = useState<IntegrationEnvironment>(detail.defaultEnvironment);
  const envData = detail.environments.find((e) => e.environment === environment)!;
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const selected: IntegrationConfigDto | null =
    envData.versions.find((v) => v.version === selectedVersion) ?? envData.active ?? envData.versions[0] ?? null;
  const [adapter, setAdapter] = useState<string>(selected?.adapter ?? descriptor.adapters[0]!.id);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<IntegrationCheckResult | null>(null);
  const [forceDialog, setForceDialog] = useState(false);
  const [disableDialog, setDisableDialog] = useState(false);
  const [rotateDialog, setRotateDialog] = useState(false);
  const [rotateField, setRotateField] = useState(descriptor.secrets[0]?.key ?? '');
  const [rotateValue, setRotateValue] = useState('');

  const secretsLocked = descriptor.secretsPermission ? !permissions.paymentCredentials : false;
  const canWrite = permissions.manage && permissions.mfaVerified;
  const canRotate = permissions.rotate && permissions.mfaVerified && !secretsLocked && descriptor.secrets.length > 0;
  const isDefaultEnv = environment === detail.defaultEnvironment;

  const schema = useMemo(() => buildSchema(descriptor.fields), [descriptor.fields]);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultsFrom(descriptor.fields, selected?.settings),
    mode: 'onBlur',
  });
  const { reset } = form;
  useEffect(() => {
    reset(defaultsFrom(descriptor.fields, selected?.settings));
    setAdapter(selected?.adapter ?? descriptor.adapters[0]!.id);
    setSecretInputs({});
    setClearSecrets([]);
    setCheck(null);
    setError(null);
  }, [reset, descriptor, selected?.id, selected?.settings, selected?.adapter, environment]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const base = `/api/v1/admin/integrations/${descriptor.provider}`;

  const onSave = form.handleSubmit(async (values) => {
    const settings: Record<string, unknown> = {};
    for (const f of descriptor.fields) {
      const v = values[f.key];
      if (v === undefined || v === '' || v === null) continue;
      settings[f.key] = v;
    }
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(secretInputs)) if (v.trim()) secrets[k] = v;
    const saved = await run('save', () =>
      apiFetch<IntegrationConfigDto>(base, { method: 'PUT', body: { environment, adapter, settings, secrets, clearSecrets } }),
    );
    if (saved) {
      toast({ title: `Version ${saved.version} saved`, description: 'Saved, not tested. Run the connection test next.', tone: 'success' });
      setSelectedVersion(saved.version);
      router.refresh();
    }
  });

  async function onTest(version: number) {
    const result = await run('test', () =>
      apiFetch<IntegrationCheckResult>(`${base}/test`, { method: 'POST', body: { environment, version } }),
    );
    if (result) {
      setCheck(result);
      setSelectedVersion(version);
      router.refresh();
    }
  }

  async function activate(version: number, force: boolean, reason?: string) {
    const dto = await apiFetch<IntegrationConfigDto>(`${base}/activate`, { method: 'POST', body: { environment, version, force, reason } });
    toast({ title: `Version ${dto.version} is now active`, description: statusLabel(dto.status, dto), tone: dto.status === 'connected' ? 'success' : 'info' });
    setSelectedVersion(dto.version);
    router.refresh();
  }

  async function onActivate(version: number) {
    const target = envData.versions.find((v) => v.version === version);
    if (target?.lastCheckOk === true) await run('activate', () => activate(version, false));
    else setForceDialog(true);
  }

  async function onDisable(reason: string) {
    await apiFetch<IntegrationConfigDto>(`${base}/disable`, { method: 'POST', body: { environment, reason } });
    toast({ title: `${descriptor.name} disabled for ${environment}`, tone: 'info' });
    router.refresh();
  }

  async function onRotate(reason: string) {
    if (!rotateValue.trim()) throw new Error('Enter the new secret value');
    const res = await apiFetch<{ config: IntegrationConfigDto; activated: boolean; check: { ok: boolean; message: string } | null }>(
      `${base}/rotate-secret`,
      { method: 'POST', body: { environment, field: rotateField, value: rotateValue, reason } },
    );
    setRotateValue('');
    toast({
      title: `Secret rotated into version ${res.config.version}`,
      description: res.check
        ? res.activated
          ? `Verified and activated: ${res.check.message}`
          : `Verification failed: ${res.check.message}. The previous secret is retired; fix and re-test.`
        : 'Test and activate the new version to use it.',
      tone: res.check && !res.check.ok ? 'danger' : 'success',
    });
    setSelectedVersion(res.config.version);
    router.refresh();
  }

  const fieldErrors = Object.entries(form.formState.errors).map(([k, e]) => ({
    id: `int-${k}`,
    message: `${descriptor.fields.find((f) => f.key === k)?.label ?? k}: ${String((e as { message?: string })?.message ?? 'invalid')}`,
  }));

  const versionColumns: Column<IntegrationConfigDto>[] = [
    { key: 'version', header: 'Version', cell: (v) => <span className="font-medium">v{v.version}</span> },
    { key: 'status', header: 'State', cell: (v) => <StatusBadge status={v.status} label={statusLabel(v.status, v)} /> },
    { key: 'adapter', header: 'Adapter', cell: (v) => <ModeBadge dto={v} /> },
    {
      key: 'check',
      header: 'Last test',
      cell: (v) => (v.lastCheckAt ? <span className="text-xs">{v.lastCheckOk ? 'passed' : 'failed'} · {fmtDate(v.lastCheckAt)}</span> : <span className="text-xs text-fg-muted">never</span>),
    },
    { key: 'active', header: 'Active', cell: (v) => (v.isActive ? <Badge tone="success">active</Badge> : <span className="text-xs text-fg-muted">—</span>) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (v) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setSelectedVersion(v.version)} aria-pressed={selected?.id === v.id}>
            View
          </Button>
          {permissions.test ? (
            <Button size="sm" variant="secondary" onClick={() => onTest(v.version)} loading={busy === 'test'} loadingLabel="Testing">
              Test
            </Button>
          ) : null}
          {canWrite && !v.isActive ? (
            <Button size="sm" variant="primary" onClick={() => { setSelectedVersion(v.version); void onActivate(v.version); }} disabled={busy !== null}>
              Activate
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const logColumns: Column<IntegrationLogDto>[] = [
    { key: 'at', header: 'When', cell: (l) => <span className="text-xs">{fmtDate(l.createdAt)}</span> },
    { key: 'env', header: 'Env', cell: (l) => <Badge tone={l.environment === 'live' ? 'gold' : 'neutral'}>{l.environment}</Badge> },
    { key: 'level', header: 'Level', cell: (l) => <Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warning' : 'neutral'}>{l.level}</Badge> },
    { key: 'event', header: 'Event', cell: (l) => <Mono>{l.event}</Mono> },
    { key: 'message', header: 'Message', cell: (l) => <span className="text-sm">{l.message ?? '—'}</span> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Field label="Environment" className="min-w-48">
          {({ id }) => (
            <NativeSelect id={id} value={environment} onChange={(e) => { setEnvironment(e.target.value as IntegrationEnvironment); setSelectedVersion(null); }}>
              <option value="test">test</option>
              <option value="live">live</option>
            </NativeSelect>
          )}
        </Field>
        <p className="text-sm text-fg-muted">
          {isDefaultEnv ? `The runtime reads the ${environment} environment (APP_ENV=${detail.appEnv}).` : `The runtime currently reads the ${detail.defaultEnvironment} environment; ${environment} settings are kept separate.`}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{selected ? `Version ${selected.version}` : 'No saved configuration'}</CardTitle>
                {selected ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={selected.status} label={statusLabel(selected.status, selected)} />
                    <ModeBadge dto={selected} />
                    {selected.isActive ? <Badge tone="success">active</Badge> : null}
                  </div>
                ) : null}
              </div>
              {selected?.remedialAction ? <p className="text-sm text-fg-muted">{selected.remedialAction}</p> : null}
            </CardHeader>
            <CardContent>
              <form onSubmit={onSave} noValidate className="space-y-5">
                {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}
                <ErrorSummary errors={fieldErrors} />
                <Field label="Adapter" required hint={descriptor.devAdapter ? 'Development adapters are labelled and refused in production.' : undefined}>
                  {({ id }) => (
                    <NativeSelect id={id} value={adapter} onChange={(e) => setAdapter(e.target.value)} disabled={!canWrite}>
                      {descriptor.adapters.map((a) => (
                        <option key={a.id} value={a.id}>{a.label}</option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>

                <fieldset className="space-y-4" disabled={!canWrite}>
                  <legend className="text-sm font-medium">Settings</legend>
                  {descriptor.fields.map((f) => (
                    <Controller
                      key={f.key}
                      name={f.key}
                      control={form.control}
                      render={({ field, fieldState }) => (
                        <Field label={f.label} htmlFor={`int-${f.key}`} hint={f.help || undefined} required={f.required} error={fieldState.error?.message}>
                          {({ id, describedBy, invalid }) => {
                            if (f.kind === 'boolean')
                              return (
                                <div className="flex items-center gap-3">
                                  <Switch id={id} checked={Boolean(field.value)} onCheckedChange={field.onChange} label={f.label} disabled={!canWrite} />
                                  <span className="text-sm">{field.value ? 'On' : 'Off'}</span>
                                </div>
                              );
                            if (f.kind === 'enum')
                              return (
                                <NativeSelect id={id} aria-describedby={describedBy} aria-invalid={invalid} value={String(field.value ?? '')} onChange={field.onChange} onBlur={field.onBlur}>
                                  {!f.required ? <option value="">—</option> : null}
                                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                                </NativeSelect>
                              );
                            if (f.kind === 'string_list' && f.options)
                              return (
                                <div id={id} role="group" aria-describedby={describedBy} className="flex flex-wrap gap-3">
                                  {f.options.map((o) => {
                                    const list = (field.value as string[]) ?? [];
                                    const checked = list.includes(o);
                                    return (
                                      <label key={o} className="inline-flex items-center gap-2 text-sm">
                                        <input
                                          type="checkbox"
                                          className="h-4 w-4 accent-primary"
                                          checked={checked}
                                          disabled={!canWrite}
                                          onChange={(e) => field.onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))}
                                        />
                                        {o}
                                      </label>
                                    );
                                  })}
                                </div>
                              );
                            if (f.kind === 'string_list')
                              return (
                                <Textarea
                                  id={id}
                                  aria-describedby={describedBy}
                                  aria-invalid={invalid}
                                  className="min-h-24 font-mono text-xs"
                                  placeholder="One entry per line"
                                  value={((field.value as string[]) ?? []).join('\n')}
                                  onChange={(e) => field.onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                                  onBlur={field.onBlur}
                                />
                              );
                            return (
                              <Input
                                id={id}
                                aria-describedby={describedBy}
                                aria-invalid={invalid}
                                type={f.kind === 'integer' ? 'number' : f.kind === 'email' ? 'email' : f.kind === 'url' ? 'url' : 'text'}
                                inputMode={f.kind === 'integer' ? 'numeric' : undefined}
                                placeholder={f.placeholder}
                                value={String(field.value ?? '')}
                                onChange={field.onChange}
                                onBlur={field.onBlur}
                                autoComplete="off"
                              />
                            );
                          }}
                        </Field>
                      )}
                    />
                  ))}
                </fieldset>

                {descriptor.secrets.length > 0 ? (
                  <fieldset className="space-y-4" disabled={!canWrite || secretsLocked}>
                    <legend className="text-sm font-medium">Secrets (write-only)</legend>
                    {secretsLocked ? (
                      <Alert tone="info" title="Payment credentials need an extra permission">
                        Changing Paystack keys requires integrations.payment_credentials.manage.
                      </Alert>
                    ) : null}
                    {descriptor.secrets.map((s) => {
                      const presence = selected?.secrets[s.key];
                      const clearing = clearSecrets.includes(s.key);
                      return (
                        <Field
                          key={s.key}
                          label={s.label}
                          htmlFor={`sec-${s.key}`}
                          required={s.required && !presence?.set}
                          hint={
                            <span>
                              {presence?.set ? (
                                <>
                                  Set (fingerprint <Mono>{presence.fingerprint}</Mono>, entered {fmtDate(presence.updatedAt)}). Leave blank to keep it.
                                </>
                              ) : (
                                'Not set.'
                              )}{' '}
                              {s.help}
                            </span>
                          }
                        >
                          {({ id, describedBy }) => (
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <Input
                                id={id}
                                aria-describedby={describedBy}
                                type="password"
                                autoComplete="new-password"
                                spellCheck={false}
                                placeholder={presence?.set ? '•••••••• (unchanged)' : 'Enter value'}
                                value={secretInputs[s.key] ?? ''}
                                disabled={clearing}
                                onChange={(e) => setSecretInputs((prev) => ({ ...prev, [s.key]: e.target.value }))}
                              />
                              {presence?.set && !s.required ? (
                                <label className="inline-flex items-center gap-2 text-xs whitespace-nowrap">
                                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={clearing} onChange={(e) => setClearSecrets((prev) => (e.target.checked ? [...prev, s.key] : prev.filter((k) => k !== s.key)))} />
                                  Remove
                                </label>
                              ) : null}
                            </div>
                          )}
                        </Field>
                      );
                    })}
                  </fieldset>
                ) : null}

                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button type="submit" disabled={!canWrite || busy !== null} loading={busy === 'save'} loadingLabel="Saving">
                    Save as new version
                  </Button>
                  <Button type="button" variant="secondary" disabled={!selected || !permissions.test || busy !== null} loading={busy === 'test'} loadingLabel="Testing" onClick={() => selected && onTest(selected.version)}>
                    Test connection
                  </Button>
                  <Button
                    type="button"
                    variant="accent"
                    disabled={!selected || selected.isActive || !canWrite || busy !== null || selected.lastCheckOk !== true}
                    loading={busy === 'activate'}
                    loadingLabel="Activating"
                    onClick={() => selected && onActivate(selected.version)}
                    title={selected && selected.lastCheckOk !== true ? 'Run a passing connection test first' : undefined}
                  >
                    Activate
                  </Button>
                  {selected && !selected.isActive && selected.lastCheckOk !== true && canWrite ? (
                    <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setForceDialog(true)}>
                      Activate without a test…
                    </Button>
                  ) : null}
                  <Button type="button" variant="danger" disabled={!envData.active || !canWrite || busy !== null} onClick={() => setDisableDialog(true)}>
                    Disable
                  </Button>
                  <Button type="button" variant="secondary" disabled={!selected || !canRotate || busy !== null} onClick={() => setRotateDialog(true)}>
                    Rotate secret…
                  </Button>
                </div>
                <p className="text-xs text-fg-muted">
                  Save writes a new version and never activates it. Test runs the real provider check and records the outcome. Activate switches the runtime to a version that passed its test.
                </p>
              </form>
            </CardContent>
          </Card>

          {check ? (
            <Alert tone={check.ok ? 'success' : 'danger'} title={`${check.ok ? 'Test passed' : 'Test failed'} · version ${check.config.version} · ${check.mode === 'development' ? 'development adapter (not a real provider)' : check.adapter}`}>
              <p>{check.message}</p>
              <p className="mt-1 text-xs text-fg-muted">Checked {fmtDate(check.checkedAt)}{check.environmentDetected ? ` · environment detected: ${check.environmentDetected}` : ''}</p>
              {Object.keys(check.details).length > 0 ? <div className="mt-2"><JsonBlock value={check.details} /></div> : null}
            </Alert>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Versions · {environment}</CardTitle></CardHeader>
            <CardContent>
              <DataTable columns={versionColumns} rows={envData.versions} rowKey={(v) => v.id} rowLabel={(v) => `version ${v.version}`} caption={`${descriptor.name} ${environment} versions`} emptyMessage="Nothing saved for this environment yet." />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Log</CardTitle></CardHeader>
            <CardContent>
              <DataTable columns={logColumns} rows={logs} rowKey={(l) => l.id} rowLabel={(l) => l.event} caption={`${descriptor.name} log`} emptyMessage="No log entries yet." />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Setup</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                Guide: <Mono>{descriptor.docsPath}</Mono> (repository). The index at <Mono>docs/providers/README.md</Mono> lists what to supply, where to enter it, how to test, activate and rotate.
              </p>
              {descriptor.facts.map((f) => (
                <div key={f.label}>
                  <p className="text-xs uppercase tracking-wide text-fg-muted">{f.label}</p>
                  <p className="break-all"><Mono>{f.value}</Mono></p>
                </div>
              ))}
              {descriptor.provider === 'google_workspace' ? (
                <Alert tone="info" title="Organiser grant is separate">
                  A client ID and secret do not connect a calendar. After activating, an organiser must complete the OAuth grant at{' '}
                  <Link href="/api/v1/calendar/connect" className="underline">/api/v1/calendar/connect</Link>; token health is shown there.
                </Alert>
              ) : null}
              {selected ? (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-fg-muted">Last success</dt><dd>{fmtDate(selected.lastSuccessAt)}</dd>
                  <dt className="text-fg-muted">Credential rotated</dt><dd>{fmtDate(selected.credentialRotatedAt)}</dd>
                  <dt className="text-fg-muted">Activated</dt><dd>{fmtDate(selected.activatedAt)}</dd>
                  <dt className="text-fg-muted">Updated</dt><dd>{fmtDate(selected.updatedAt)}</dd>
                </dl>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <ActionDialog
        open={forceDialog}
        onOpenChange={setForceDialog}
        title={`Activate version ${selected?.version ?? ''} without a passed test`}
        description="The runtime will use this version although no connection test has passed. It will be shown as “Active, not verified” until a test passes. Recorded in the audit log."
        confirmLabel="Activate anyway"
        tone="danger"
        requireReason
        onConfirm={(reason) => (selected ? activate(selected.version, true, reason) : Promise.resolve())}
      />
      <ActionDialog
        open={disableDialog}
        onOpenChange={setDisableDialog}
        title={`Disable ${descriptor.name} (${environment})`}
        description="The active version stops being used immediately. Features depending on it will report the provider as not configured."
        confirmLabel="Disable"
        tone="danger"
        requireReason
        onConfirm={onDisable}
      />
      <ActionDialog
        open={rotateDialog}
        onOpenChange={(o) => { setRotateDialog(o); if (!o) setRotateValue(''); }}
        title="Rotate a secret"
        description="Stores the new value as a fresh encrypted record, retires the previous one and creates a new configuration version with the other secrets unchanged. If the current version is active, the new version is verified and activated only when the check passes."
        confirmLabel="Rotate"
        requireReason
        onConfirm={onRotate}
      >
        <Field label="Secret" required>
          {({ id }) => (
            <NativeSelect id={id} value={rotateField} onChange={(e) => setRotateField(e.target.value)}>
              {descriptor.secrets.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label="New value" required hint="Never displayed again after saving.">
          {({ id }) => <Input id={id} type="password" autoComplete="new-password" spellCheck={false} value={rotateValue} onChange={(e) => setRotateValue(e.target.value)} />}
        </Field>
      </ActionDialog>
    </div>
  );
}
