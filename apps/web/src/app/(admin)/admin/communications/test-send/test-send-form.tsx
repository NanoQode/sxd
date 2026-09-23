'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CommunicationsTestSendResponse, DeliveryLogItemDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { fmtDate, Mono } from '../../_components/bits';
import {
  DELIVERY_CONFIRMATION_LABELS,
  DELIVERY_STATUS_LABELS,
  DELIVERY_STATUS_TONES,
  DEV_ADAPTER_LABEL,
  explainReason,
} from '../_lib/labels';
import { DeliveryTimeline } from '../_components/delivery-timeline';

export interface ProviderHint {
  channel: 'email' | 'sms';
  adapter: string;
  environment: string;
  configured: boolean;
  devFallback: boolean;
  status: string;
}

export interface TemplateOption {
  key: string;
  channel: 'email' | 'sms';
  activeVersion: number | null;
  latestVersion: number;
}

const DELIVERIES = '/api/v1/admin/notifications/deliveries';

function AdapterBadge({ hint }: { hint: ProviderHint | undefined }) {
  if (!hint) return null;
  if (hint.devFallback)
    return <Badge tone="warning">Development adapter — no real message will be sent</Badge>;
  if (!hint.configured)
    return (
      <Badge tone="danger">Not configured — the send will fail with provider_not_configured</Badge>
    );
  return (
    <Badge tone="primary">
      {hint.adapter} · {hint.environment}
    </Badge>
  );
}

/** Provider answer (accepted / rejected) — distinct from delivery. */
function ProviderAnswer({ result }: { result: CommunicationsTestSendResponse }) {
  const status = result.outcome.status;
  const accepted = status === 'accepted' || status === 'sent';
  const title = accepted
    ? result.attempt?.channel === 'sms'
      ? 'Accepted by the SMS provider'
      : 'Accepted by the SMTP relay'
    : status === 'suppressed'
      ? 'Not sent: address suppressed'
      : status === 'queued'
        ? 'Provider asked for a retry'
        : 'Rejected';
  return (
    <Alert tone={accepted ? 'success' : status === 'queued' ? 'warning' : 'danger'} title={title}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-fg-muted">Recipient</dt>
        <dd>
          <Mono>{result.to}</Mono>
        </dd>
        <dt className="text-fg-muted">Adapter</dt>
        <dd>
          {result.provider.developmentAdapter ? (
            <Badge tone="warning">{DEV_ADAPTER_LABEL}</Badge>
          ) : (
            <span>
              {result.provider.adapter} · {result.provider.environment}
            </span>
          )}
        </dd>
        {result.outcome.providerMessageId ? (
          <>
            <dt className="text-fg-muted">Provider message id</dt>
            <dd>
              <Mono>{result.outcome.providerMessageId}</Mono>
            </dd>
          </>
        ) : null}
        {result.outcome.reason ? (
          <>
            <dt className="text-fg-muted">Reason</dt>
            <dd>
              <Mono>{result.outcome.reason}</Mono>
              {explainReason(result.outcome.reason) ? (
                <span className="ml-2 text-fg-muted">{explainReason(result.outcome.reason)}</span>
              ) : null}
            </dd>
          </>
        ) : null}
        {result.provider.reason && !result.outcome.reason ? (
          <>
            <dt className="text-fg-muted">Provider</dt>
            <dd>{result.provider.reason}</dd>
          </>
        ) : null}
      </dl>
    </Alert>
  );
}

export function TestSendForm({
  providers,
  templates,
  canOpenLog,
  templatesKnown,
}: {
  providers: ProviderHint[];
  templates: TemplateOption[];
  canOpenLog: boolean;
  templatesKnown: boolean;
}) {
  const { toast } = useToast();
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [to, setTo] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommunicationsTestSendResponse | null>(null);
  const [attempt, setAttempt] = useState<DeliveryLogItemDto | null>(null);

  const hint = providers.find((p) => p.channel === channel);
  const options = templates.filter((t) => t.channel === channel && t.key !== 'test_message');

  async function send() {
    setBusy('send');
    setError(null);
    setResult(null);
    setAttempt(null);
    try {
      const res = await apiFetch<CommunicationsTestSendResponse>(
        '/api/v1/admin/notifications/test-send',
        {
          method: 'POST',
          body: { channel, to, templateKey: templateKey || undefined },
        },
      );
      setResult(res);
      setAttempt(res.attempt);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    if (!attempt) return;
    setBusy('refresh');
    try {
      setAttempt(await apiFetch<DeliveryLogItemDto>(`${DELIVERIES}/${attempt.id}`));
    } catch (err) {
      toast({ title: 'Could not refresh', description: errorMessage(err), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function simulate(state: 'delivered' | 'failed') {
    if (!attempt) return;
    setBusy(`sim:${state}`);
    try {
      const res = await apiFetch<{ action: string; attempt: DeliveryLogItemDto }>(
        `${DELIVERIES}/${attempt.id}/simulate-receipt`,
        { method: 'POST', body: { state } },
      );
      setAttempt(res.attempt);
      toast({
        title: `Simulated receipt processed (${res.action})`,
        description: 'The signed development receipt went through the real webhook handler.',
        tone: 'info',
      });
    } catch (err) {
      toast({ title: 'Simulation refused', description: errorMessage(err), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Send a test</CardTitle>
          <CardDescription>
            Nothing goes to customers. The address you enter is the only recipient.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {error ? (
              <Alert tone="danger" title="Test not sent">
                {error}
              </Alert>
            ) : null}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Channel</legend>
              <div className="flex flex-wrap gap-4">
                {(['email', 'sms'] as const).map((c) => (
                  <label key={c} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="channel"
                      value={c}
                      checked={channel === c}
                      onChange={() => {
                        setChannel(c);
                        setTemplateKey('');
                      }}
                      className="h-4 w-4 accent-primary"
                    />
                    {c === 'email' ? 'Email' : 'SMS'}
                  </label>
                ))}
              </div>
              <AdapterBadge hint={hint} />
            </fieldset>
            <Field
              label={channel === 'email' ? 'Recipient email' : 'Recipient phone'}
              required
              hint={
                channel === 'email'
                  ? 'Use your own address or a team inbox.'
                  : 'Any format; stored and shown as E.164 (+234…). Development adapter: numbers ending 0000 are rejected, 1111 fail later, 2222 are rejected by the network.'
              }
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type={channel === 'email' ? 'email' : 'tel'}
                  inputMode={channel === 'email' ? 'email' : 'tel'}
                  autoComplete="off"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="max-w-md"
                />
              )}
            </Field>
            <Field
              label="Template"
              hint={
                templatesKnown
                  ? 'Templates other than the plain test message render with sample values.'
                  : 'Listing templates needs notifications.templates.manage; the plain test message is always available.'
              }
            >
              {({ id, describedBy }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  value={templateKey}
                  onChange={(e) => setTemplateKey(e.target.value)}
                  className="max-w-md"
                >
                  <option value="">Plain test message (test_message)</option>
                  {options.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.key}
                      {t.activeVersion !== null
                        ? ` · v${t.activeVersion}`
                        : ` · draft v${t.latestVersion} (no active version)`}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            {to.trim() ? (
              <p className="text-sm">
                Will send to <Mono>{to.trim()}</Mono> only.
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={!to.trim() || busy !== null}
              loading={busy === 'send'}
              loadingLabel="Sending"
            >
              Send test {channel === 'email' ? 'email' : 'SMS'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-6">
        {result ? (
          <>
            <section aria-labelledby="provider-answer" className="space-y-2">
              <h2
                id="provider-answer"
                className="text-sm font-medium uppercase tracking-wide text-fg-muted"
              >
                1 · Provider answer
              </h2>
              <ProviderAnswer result={result} />
            </section>
            <section aria-labelledby="delivery-status" className="space-y-2">
              <h2
                id="delivery-status"
                className="text-sm font-medium uppercase tracking-wide text-fg-muted"
              >
                2 · Delivery status
              </h2>
              {attempt ? (
                <Card>
                  <CardContent className="space-y-3 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={DELIVERY_STATUS_TONES[attempt.status] ?? 'neutral'}>
                        {DELIVERY_STATUS_LABELS[attempt.status] ?? attempt.status}
                      </Badge>
                      <span className="text-fg-muted">
                        {DELIVERY_CONFIRMATION_LABELS[attempt.delivery]}
                      </span>
                    </div>
                    <DeliveryTimeline steps={attempt.timeline} />
                    {attempt.errorSanitized ? (
                      <p>
                        <span className="text-fg-muted">Failure reason:</span>{' '}
                        <Mono>{attempt.errorSanitized}</Mono>
                      </p>
                    ) : null}
                    <p className="text-xs text-fg-muted">
                      Attempt <Mono>{attempt.id}</Mono> · labelled test · queued{' '}
                      {fmtDate(attempt.queuedAt)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={refresh}
                        loading={busy === 'refresh'}
                        loadingLabel="Refreshing"
                        disabled={busy !== null}
                      >
                        Refresh status
                      </Button>
                      {attempt.developmentAdapter &&
                      attempt.channel === 'sms' &&
                      attempt.status === 'accepted' ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy !== null}
                            loading={busy === 'sim:delivered'}
                            loadingLabel="Simulating"
                            onClick={() => simulate('delivered')}
                          >
                            Simulate “delivered” receipt (dev)
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy !== null}
                            loading={busy === 'sim:failed'}
                            loadingLabel="Simulating"
                            onClick={() => simulate('failed')}
                          >
                            Simulate “failed” receipt (dev)
                          </Button>
                        </>
                      ) : null}
                      {canOpenLog ? (
                        <Link
                          href={`/admin/communications/deliveries?testOnly=1&recipient=${encodeURIComponent(result.to)}`}
                          className="sx-touch inline-flex items-center text-sm underline"
                        >
                          Open in delivery log
                        </Link>
                      ) : null}
                    </div>
                    {attempt.developmentAdapter ? (
                      <p className="text-xs text-fg-muted">
                        The development adapter keeps messages in memory and never reports delivery
                        on its own; simulated receipts exercise the real webhook handler.
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              ) : (
                <Alert tone="warning" title="No delivery attempt was recorded">
                  The pipeline did not reach a provider (see the provider answer).
                </Alert>
              )}
            </section>
            {result.samples.length > 0 ? (
              <details className="rounded-md border border-border p-3 text-sm">
                <summary className="cursor-pointer font-medium">
                  Sample values used ({result.samples.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {result.samples.map((s) => (
                    <li key={s.name}>
                      <Mono>{s.name}</Mono> → {s.value}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : (
          <Card>
            <CardContent className="p-4 text-sm text-fg-muted">
              <p>After sending you will see two separate results:</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  the provider’s answer — accepted, or rejected with the sanitised reason — and
                  which adapter handled it;
                </li>
                <li>
                  delivery status, which changes only when the provider reports it (SMS receipt or
                  email bounce). Acceptance is not delivery.
                </li>
              </ol>
              <p className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status="accepted" label="Accepted" /> ≠{' '}
                <StatusBadge status="delivered" label="Delivered" />
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
