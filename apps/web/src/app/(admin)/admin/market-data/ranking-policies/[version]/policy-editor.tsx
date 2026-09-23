'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { RankingPolicyDto } from '@simplexd/contracts';
import {
  METRIC_KEYS,
  validateRankingPolicy,
  type ConfidenceRubric,
  type MetricBound,
  type MetricKey,
} from '@simplexd/domain/ranking';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../../_components/action-dialog';
import { JsonBlock } from '../../../_components/bits';

interface BoundRow {
  metric: string;
  direction: 'higher_is_better' | 'lower_is_better';
  unit: string;
  low: string;
  high: string;
  cohort: string;
  note: string;
}

export function PolicyEditor({
  policy,
  canManage,
}: {
  policy: RankingPolicyDto;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const editable = canManage && policy.status === 'draft';
  const [name, setName] = useState(policy.name);
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(METRIC_KEYS.map((k) => [k, String(policy.weights[k] ?? 0)])),
  );
  const [bounds, setBounds] = useState<BoundRow[]>(
    policy.metricBounds.map((b) => ({
      metric: b.metric,
      direction: b.direction,
      unit: b.unit,
      low: String(b.low),
      high: String(b.high),
      cohort: b.cohort ?? '',
      note: b.note ?? '',
    })),
  );
  const [rubric, setRubric] = useState(JSON.stringify(policy.confidenceRubric, null, 2));
  const [coverage, setCoverage] = useState(String(policy.coverageThreshold));
  const [minComparables, setMinComparables] = useState(String(policy.minComparables));
  const [notes, setNotes] = useState(policy.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState(policy.errors);
  const [activate, setActivate] = useState(false);

  const { clientErrors, rubricError } = useMemo(() => {
    let parsedRubric: ConfidenceRubric | null = null;
    let rubricError: string | null = null;
    try {
      parsedRubric = JSON.parse(rubric) as ConfidenceRubric;
    } catch (e) {
      rubricError = e instanceof Error ? e.message : 'invalid JSON';
    }
    const errs = validateRankingPolicy({
      version: policy.version,
      weights: Object.fromEntries(METRIC_KEYS.map((k) => [k, Number(weights[k])])) as Record<
        MetricKey,
        number
      >,
      metricBounds: bounds.map((b) => ({
        metric: b.metric as MetricKey,
        direction: b.direction,
        unit: b.unit,
        low: Number(b.low),
        high: Number(b.high),
        ...(b.cohort ? { cohort: b.cohort } : {}),
      })) as MetricBound[],
      confidenceRubric: parsedRubric ?? ({} as ConfidenceRubric),
      coverageThreshold: Number(coverage),
      minComparables: Number(minComparables),
    });
    return { clientErrors: errs, rubricError };
  }, [policy.version, weights, bounds, rubric, coverage, minComparables]);

  const weightSum = METRIC_KEYS.reduce((s, k) => s + (Number(weights[k]) || 0), 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<RankingPolicyDto>(
        `/api/v1/admin/ranking-policies/${policy.version}`,
        {
          method: 'PATCH',
          body: {
            name,
            weights: Object.fromEntries(METRIC_KEYS.map((k) => [k, Number(weights[k]) || 0])),
            metricBounds: bounds.map((b) => ({
              metric: b.metric,
              direction: b.direction,
              unit: b.unit,
              low: Number(b.low),
              high: Number(b.high),
              ...(b.cohort ? { cohort: b.cohort } : {}),
              ...(b.note ? { note: b.note } : {}),
            })),
            confidenceRubric: JSON.parse(rubric),
            coverageThreshold: Number(coverage),
            minComparables: Number(minComparables),
            notes: notes || null,
          },
        },
      );
      setServerErrors(res.errors);
      toast({
        title: 'Draft saved',
        description: res.errors.length
          ? `${res.errors.length} error(s) block activation`
          : 'Valid; ready to activate',
        tone: res.errors.length ? 'info' : 'success',
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doActivate(reason: string) {
    await apiFetch(`/api/v1/admin/ranking-policies/${policy.version}/activate`, {
      method: 'POST',
      body: { reason },
    });
    toast({ title: `Policy v${policy.version} is now active`, tone: 'success' });
    router.push('/admin/market-data/ranking-policies');
    router.refresh();
  }

  const errorsToShow = editable ? clientErrors : serverErrors;

  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="Could not save">
          {error}
        </Alert>
      ) : null}
      {errorsToShow.length > 0 ? (
        <Alert tone="danger" title={`${errorsToShow.length} configuration error(s)`}>
          <ul className="mt-1 list-disc pl-5">
            {errorsToShow.map((e, i) => (
              <li key={i}>
                {e.metric ? <code>{e.metric}</code> : 'policy'}: {e.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="success" title="Policy configuration is valid" />
      )}
      {rubricError ? (
        <Alert tone="danger" title="Confidence rubric is not valid JSON">
          {rubricError}
        </Alert>
      ) : null}
      {!editable && policy.status === 'draft' ? (
        <Alert tone="info">
          Editing needs market_data.policy.manage and a verified authenticator.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Weights</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-fg-muted">
            Saved weights are renormalised per run (yield is omitted for owner-occupier goals). Sum
            now: {weightSum.toFixed(2)}.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {METRIC_KEYS.map((k) => (
              <Field key={k} label={k.replace(/_/g, ' ')}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    step="0.01"
                    min={0}
                    value={weights[k] ?? ''}
                    disabled={!editable}
                    onChange={(e) => setWeights((w) => ({ ...w, [k]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metric bounds (normalisation anchors)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Metric bounds</caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-2 py-1">Metric</th>
                  <th className="px-2 py-1">Direction</th>
                  <th className="px-2 py-1">Unit</th>
                  <th className="px-2 py-1">Low</th>
                  <th className="px-2 py-1">High</th>
                  <th className="px-2 py-1">Cohort</th>
                  <th className="px-2 py-1">Note</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {bounds.map((b, i) => {
                  const update = (patch: Partial<BoundRow>) =>
                    setBounds((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1">
                        <NativeSelect
                          aria-label="Metric"
                          value={b.metric}
                          disabled={!editable}
                          onChange={(e) => update({ metric: e.target.value })}
                        >
                          {METRIC_KEYS.map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </NativeSelect>
                      </td>
                      <td className="px-2 py-1">
                        <NativeSelect
                          aria-label="Direction"
                          value={b.direction}
                          disabled={!editable}
                          onChange={(e) =>
                            update({ direction: e.target.value as BoundRow['direction'] })
                          }
                        >
                          <option value="higher_is_better">higher is better</option>
                          <option value="lower_is_better">lower is better</option>
                        </NativeSelect>
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label="Unit"
                          value={b.unit}
                          disabled={!editable}
                          onChange={(e) => update({ unit: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label="Low"
                          type="number"
                          step="any"
                          value={b.low}
                          disabled={!editable}
                          onChange={(e) => update({ low: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label="High"
                          type="number"
                          step="any"
                          value={b.high}
                          disabled={!editable}
                          onChange={(e) => update({ high: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label="Cohort"
                          value={b.cohort}
                          disabled={!editable}
                          onChange={(e) => update({ cohort: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label="Note"
                          value={b.note}
                          disabled={!editable}
                          onChange={(e) => update({ note: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        {editable ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setBounds((rows) => rows.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {editable ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setBounds((rows) => [
                  ...rows,
                  {
                    metric: 'affordability',
                    direction: 'lower_is_better',
                    unit: '',
                    low: '0',
                    high: '1',
                    cohort: '',
                    note: '',
                  },
                ])
              }
            >
              Add bound
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Confidence rubric</CardTitle>
          </CardHeader>
          <CardContent>
            {editable ? (
              <Textarea
                aria-label="Confidence rubric JSON"
                className="min-h-72 font-mono text-xs"
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
              />
            ) : (
              <JsonBlock value={policy.confidenceRubric} />
            )}
            <p className="mt-2 text-xs text-fg-muted">
              Multipliers in [0, 1] for source quality, freshness, geographic match and sample size.
              Configuration, not hidden judgment.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Gates and notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Name">
              {({ id }) => (
                <Input
                  id={id}
                  value={name}
                  disabled={!editable}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Coverage threshold (0–1)"
              hint="Minimum weighted coverage for an investment ranking."
            >
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  step="0.01"
                  min={0}
                  max={1}
                  value={coverage}
                  disabled={!editable}
                  onChange={(e) => setCoverage(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Minimum deduplicated comparables"
              hint="Publication policy for local medians; travels with the policy version."
            >
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  value={minComparables}
                  disabled={!editable}
                  onChange={(e) => setMinComparables(e.target.value)}
                />
              )}
            </Field>
            <Field label="Notes">
              {({ id }) => (
                <Textarea
                  id={id}
                  className="min-h-20"
                  value={notes}
                  disabled={!editable}
                  onChange={(e) => setNotes(e.target.value)}
                />
              )}
            </Field>
            {policy.hardConstraints ? <JsonBlock value={policy.hardConstraints} /> : null}
          </CardContent>
        </Card>
      </div>

      {editable ? (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={save}
            loading={busy}
            loadingLabel="Saving"
            disabled={Boolean(rubricError)}
          >
            Save draft
          </Button>
          <Button
            variant="accent"
            onClick={() => setActivate(true)}
            disabled={clientErrors.length > 0 || Boolean(rubricError)}
          >
            Activate v{policy.version}
          </Button>
          <span className="self-center text-xs text-fg-muted">
            Save before activating; activation retires the current active version.
          </span>
        </div>
      ) : null}
      <ActionDialog
        open={activate}
        onOpenChange={setActivate}
        title={`Activate policy v${policy.version}`}
        description="Future recommendations use this version; old saved reports keep their snapshots. The previously active version is retired and caches are invalidated."
        confirmLabel="Activate"
        requireReason
        confirmText={`v${policy.version}`}
        onConfirm={doActivate}
      />
    </div>
  );
}
