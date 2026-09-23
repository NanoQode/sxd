'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  accountablePartySchema,
  dependencyTypeSchema,
  schedulePhaseSchema,
  type ScheduleDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  NativeSelect,
  Textarea,
  formatDateLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

interface TaskDraft {
  key: string;
  name: string;
  phase: string;
  durationDaysMin: string;
  durationDaysLikely: string;
  durationDaysMax: string;
  calendarBasis: string;
  leadTimeDays: string;
  accountableParty: string;
  isMilestone: boolean;
  assumptionNotes: string;
}

interface DepDraft {
  predecessorKey: string;
  successorKey: string;
  type: string;
  lagDays: string;
}

const EMPTY_TASK: TaskDraft = {
  key: '',
  name: '',
  phase: 'other',
  durationDaysMin: '',
  durationDaysLikely: '',
  durationDaysMax: '',
  calendarBasis: 'working_days',
  leadTimeDays: '0',
  accountableParty: 'unknown',
  isMilestone: false,
  assumptionNotes: '',
};

function fromSchedule(s: ScheduleDto): { tasks: TaskDraft[]; deps: DepDraft[] } {
  return {
    tasks: s.tasks.map((t) => ({
      key: t.key,
      name: t.name,
      phase: t.phase,
      durationDaysMin: t.durationDaysMin === null ? '' : String(t.durationDaysMin),
      durationDaysLikely: t.durationDaysLikely === null ? '' : String(t.durationDaysLikely),
      durationDaysMax: t.durationDaysMax === null ? '' : String(t.durationDaysMax),
      calendarBasis: t.calendarBasis,
      leadTimeDays: String(t.leadTimeDays),
      accountableParty: t.accountableParty,
      isMilestone: t.isMilestone,
      assumptionNotes: t.assumptionNotes ?? '',
    })),
    deps: s.dependencies.map((d) => ({
      predecessorKey: d.predecessorKey,
      successorKey: d.successorKey,
      type: d.type,
      lagDays: String(d.lagDays),
    })),
  };
}

const num = (v: string) => (v.trim() === '' ? null : Number(v));

export function ScheduleEditor({
  projectId,
  schedule,
  editable,
  projectStartDate,
}: {
  projectId: string;
  schedule: ScheduleDto;
  editable: boolean;
  projectStartDate: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => fromSchedule(schedule));
  const [startDate, setStartDate] = useState(schedule.startDate ?? projectStartDate ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actuals, setActuals] = useState<
    Record<string, { actualStart: string; actualFinish: string; percentComplete: string }>
  >({});

  const keyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const keys = new Set(draft.tasks.map((t) => t.key));
  const problems: string[] = [];
  if (draft.tasks.length === 0) problems.push('At least one task is required.');
  if (!startDate && !schedule.startDate)
    problems.push('A start date is required because the project has none.');
  draft.tasks.forEach((t, i) => {
    if (!keyPattern.test(t.key))
      problems.push(`Task ${i + 1}: key must be lowercase letters, digits, _ or -.`);
    if (!t.name.trim()) problems.push(`Task ${i + 1}: name is required.`);
  });
  if (keys.size !== draft.tasks.length) problems.push('Task keys must be unique.');
  draft.deps.forEach((d, i) => {
    if (!keys.has(d.predecessorKey) || !keys.has(d.successorKey))
      problems.push(`Dependency ${i + 1}: both keys must exist.`);
    if (d.predecessorKey === d.successorKey)
      problems.push(`Dependency ${i + 1}: a task cannot depend on itself.`);
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/projects/${projectId}/schedule`, {
        method: 'PUT',
        body: {
          tasks: draft.tasks.map((t, i) => ({
            key: t.key,
            name: t.name.trim(),
            phase: t.phase,
            durationDaysMin: num(t.durationDaysMin),
            durationDaysLikely: num(t.durationDaysLikely),
            durationDaysMax: num(t.durationDaysMax),
            calendarBasis: t.calendarBasis,
            leadTimeDays: Number(t.leadTimeDays) || 0,
            accountableParty: t.accountableParty,
            assumptionNotes: t.assumptionNotes.trim() || null,
            isMilestone: t.isMilestone,
            sortOrder: i,
          })),
          dependencies: draft.deps.map((d) => ({
            predecessorKey: d.predecessorKey,
            successorKey: d.successorKey,
            type: d.type,
            lagDays: Number(d.lagDays) || 0,
          })),
          startDate: startDate || undefined,
          reason: reason.trim() || undefined,
        },
      });
      toast({ title: 'Schedule saved as a new version', tone: 'success' });
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveActuals(key: string) {
    const a = actuals[key];
    if (!a) return;
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/projects/${projectId}/schedule/tasks/${key}`, {
        method: 'PATCH',
        body: {
          actualStart: a.actualStart || null,
          actualFinish: a.actualFinish || null,
          percentComplete: a.percentComplete === '' ? undefined : Number(a.percentComplete),
        },
      });
      toast({ title: `Actuals recorded for ${key}`, tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        {error ? (
          <Alert tone="danger" title="Could not save">
            {error}
          </Alert>
        ) : null}
        <DataTable
          caption="Schedule tasks"
          rows={schedule.tasks}
          rowKey={(t) => t.key}
          rowLabel={(t) => t.name}
          emptyMessage="No tasks yet. Build the schedule to compute dates and the critical path."
          columns={[
            {
              key: 'name',
              header: 'Task',
              cell: (t) => (
                <span>
                  <strong>{t.name}</strong>{' '}
                  <span className="text-xs text-fg-muted">
                    {t.key} · {humanize(t.phase)}
                  </span>
                  {t.isMilestone ? (
                    <Badge tone="gold" className="ml-1">
                      milestone
                    </Badge>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'dur',
              header: 'Duration (min/likely/max)',
              cell: (t) =>
                `${t.durationDaysMin ?? '–'} / ${t.durationDaysLikely ?? 'unknown'} / ${t.durationDaysMax ?? '–'} ${humanize(t.calendarBasis)}`,
            },
            {
              key: 'planned',
              header: 'Planned',
              cell: (t) =>
                t.computed ? (
                  `${formatDateLabel(t.computed.earlyStart)} → ${formatDateLabel(t.computed.earlyFinish)}`
                ) : (
                  <span className="text-fg-muted">not computed</span>
                ),
            },
            {
              key: 'float',
              header: 'Float',
              cell: (t) =>
                t.computed ? (
                  <span>
                    {t.computed.totalFloatDays}d{' '}
                    {t.computed.isCritical ? <Badge tone="danger">critical</Badge> : null}
                  </span>
                ) : (
                  '—'
                ),
              hideOnMobile: true,
            },
            {
              key: 'party',
              header: 'Accountable',
              cell: (t) => humanize(t.accountableParty),
              hideOnMobile: true,
            },
            {
              key: 'actuals',
              header: 'Actuals',
              cell: (t) =>
                editable ? (
                  <span className="flex flex-wrap items-end gap-1">
                    <Input
                      aria-label={`${t.key} actual start`}
                      type="date"
                      className="h-9 w-36"
                      value={actuals[t.key]?.actualStart ?? t.actualStart ?? ''}
                      onChange={(e) =>
                        setActuals({
                          ...actuals,
                          [t.key]: {
                            actualStart: e.target.value,
                            actualFinish: actuals[t.key]?.actualFinish ?? t.actualFinish ?? '',
                            percentComplete:
                              actuals[t.key]?.percentComplete ?? String(t.percentComplete),
                          },
                        })
                      }
                    />
                    <Input
                      aria-label={`${t.key} actual finish`}
                      type="date"
                      className="h-9 w-36"
                      value={actuals[t.key]?.actualFinish ?? t.actualFinish ?? ''}
                      onChange={(e) =>
                        setActuals({
                          ...actuals,
                          [t.key]: {
                            actualStart: actuals[t.key]?.actualStart ?? t.actualStart ?? '',
                            actualFinish: e.target.value,
                            percentComplete:
                              actuals[t.key]?.percentComplete ?? String(t.percentComplete),
                          },
                        })
                      }
                    />
                    <Input
                      aria-label={`${t.key} percent complete`}
                      type="number"
                      min={0}
                      max={100}
                      className="h-9 w-20"
                      value={actuals[t.key]?.percentComplete ?? String(t.percentComplete)}
                      onChange={(e) =>
                        setActuals({
                          ...actuals,
                          [t.key]: {
                            actualStart: actuals[t.key]?.actualStart ?? t.actualStart ?? '',
                            actualFinish: actuals[t.key]?.actualFinish ?? t.actualFinish ?? '',
                            percentComplete: e.target.value,
                          },
                        })
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!actuals[t.key] || busy}
                      onClick={() => void saveActuals(t.key)}
                    >
                      Save
                    </Button>
                  </span>
                ) : (
                  `${t.actualStart ?? '—'} → ${t.actualFinish ?? '—'} · ${t.percentComplete}%`
                ),
            },
          ]}
        />
        {editable ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDraft(fromSchedule(schedule));
              setEditing(true);
            }}
          >
            {schedule.tasks.length === 0 ? 'Build schedule' : 'Edit tasks and dependencies'}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert tone="danger" title="Could not save">
          {error}
        </Alert>
      ) : null}
      {problems.length > 0 ? (
        <Alert tone="warning" title="Fix before saving">
          <ul className="list-disc pl-5">
            {problems.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Start date"
          required={!schedule.startDate}
          hint="Used as day zero for the computation."
        >
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="Reason for this version">
          {({ id }) => (
            <Input
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
            />
          )}
        </Field>
      </div>
      <p className="text-sm font-medium">Tasks</p>
      <div className="space-y-2">
        {draft.tasks.map((t, i) => (
          <div key={i} className="grid gap-2 rounded-md border border-border p-2 md:grid-cols-6">
            <Input
              aria-label={`Task ${i + 1} key`}
              placeholder="key"
              value={t.key}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                })
              }
            />
            <Input
              aria-label={`Task ${i + 1} name`}
              placeholder="Name"
              className="md:col-span-2"
              value={t.name}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                })
              }
            />
            <NativeSelect
              aria-label={`Task ${i + 1} phase`}
              value={t.phase}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) => (j === i ? { ...x, phase: e.target.value } : x)),
                })
              }
            >
              {schedulePhaseSchema.options.map((ph) => (
                <option key={ph} value={ph}>
                  {humanize(ph)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={`Task ${i + 1} accountable party`}
              value={t.accountableParty}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, accountableParty: e.target.value } : x,
                  ),
                })
              }
            >
              {accountablePartySchema.options.map((ap) => (
                <option key={ap} value={ap}>
                  {humanize(ap)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={`Task ${i + 1} calendar basis`}
              value={t.calendarBasis}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, calendarBasis: e.target.value } : x,
                  ),
                })
              }
            >
              <option value="working_days">Working days</option>
              <option value="calendar_days">Calendar days</option>
            </NativeSelect>
            <Input
              aria-label={`Task ${i + 1} minimum days`}
              type="number"
              min={0}
              placeholder="Min days"
              value={t.durationDaysMin}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, durationDaysMin: e.target.value } : x,
                  ),
                })
              }
            />
            <Input
              aria-label={`Task ${i + 1} likely days`}
              type="number"
              min={0}
              placeholder="Likely days (blank = unknown)"
              value={t.durationDaysLikely}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, durationDaysLikely: e.target.value } : x,
                  ),
                })
              }
            />
            <Input
              aria-label={`Task ${i + 1} maximum days`}
              type="number"
              min={0}
              placeholder="Max days"
              value={t.durationDaysMax}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, durationDaysMax: e.target.value } : x,
                  ),
                })
              }
            />
            <Input
              aria-label={`Task ${i + 1} lead time days`}
              type="number"
              min={0}
              placeholder="Lead time"
              value={t.leadTimeDays}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, leadTimeDays: e.target.value } : x,
                  ),
                })
              }
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={t.isMilestone}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tasks: draft.tasks.map((x, j) =>
                      j === i ? { ...x, isMilestone: e.target.checked } : x,
                    ),
                  })
                }
              />
              Milestone
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.filter((_, j) => j !== i),
                  deps: draft.deps.filter(
                    (d) => d.predecessorKey !== t.key && d.successorKey !== t.key,
                  ),
                })
              }
            >
              Remove
            </Button>
            <Textarea
              aria-label={`Task ${i + 1} assumptions`}
              placeholder="Assumptions / source of the duration"
              className="min-h-10 md:col-span-6"
              value={t.assumptionNotes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  tasks: draft.tasks.map((x, j) =>
                    j === i ? { ...x, assumptionNotes: e.target.value } : x,
                  ),
                })
              }
            />
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDraft({ ...draft, tasks: [...draft.tasks, { ...EMPTY_TASK }] })}
        >
          Add task
        </Button>
      </div>
      <p className="text-sm font-medium">Dependencies</p>
      <div className="space-y-2">
        {draft.deps.map((d, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-5">
            <NativeSelect
              aria-label={`Dependency ${i + 1} predecessor`}
              value={d.predecessorKey}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  deps: draft.deps.map((x, j) =>
                    j === i ? { ...x, predecessorKey: e.target.value } : x,
                  ),
                })
              }
            >
              <option value="">Predecessor</option>
              {draft.tasks.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.key}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={`Dependency ${i + 1} type`}
              value={d.type}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  deps: draft.deps.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)),
                })
              }
            >
              {dependencyTypeSchema.options.map((ty) => (
                <option key={ty} value={ty}>
                  {humanize(ty)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={`Dependency ${i + 1} successor`}
              value={d.successorKey}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  deps: draft.deps.map((x, j) =>
                    j === i ? { ...x, successorKey: e.target.value } : x,
                  ),
                })
              }
            >
              <option value="">Successor</option>
              {draft.tasks.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.key}
                </option>
              ))}
            </NativeSelect>
            <Input
              aria-label={`Dependency ${i + 1} lag days`}
              type="number"
              placeholder="Lag days"
              value={d.lagDays}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  deps: draft.deps.map((x, j) => (j === i ? { ...x, lagDays: e.target.value } : x)),
                })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ ...draft, deps: draft.deps.filter((_, j) => j !== i) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setDraft({
              ...draft,
              deps: [
                ...draft.deps,
                { predecessorKey: '', successorKey: '', type: 'finish_to_start', lagDays: '0' },
              ],
            })
          }
        >
          Add dependency
        </Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={problems.length > 0} onClick={() => void save()}>
          Save as new schedule version
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
