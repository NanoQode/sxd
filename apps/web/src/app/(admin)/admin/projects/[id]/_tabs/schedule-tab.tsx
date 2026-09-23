import { Alert, Badge, formatDateLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { getSchedule } from '@/server/projects/schedule';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../../_components/bits';
import { ScheduleEditor } from '../_components/schedule-editor';

export async function ScheduleTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const schedule = await getSchedule(identity, p.id);
  return (
    <div className="space-y-6">
      <Section title="Computed schedule" description="Critical-path method over likely durations. Unknown durations produce a missing-input entry, never an invented date.">
        <DefinitionList
          items={[
            { term: 'Schedule version', value: `v${schedule.scheduleVersion}` },
            { term: 'Start date', value: schedule.startDate ? formatDateLabel(schedule.startDate) : 'not set' },
            { term: 'Completion', value: schedule.canComputeCompletionDate && schedule.completionDate ? formatDateLabel(schedule.completionDate) : <span className="text-fg-muted">cannot compute yet</span> },
            { term: 'Working calendar', value: `${humanize(schedule.calendarSource)} · weekend days ${schedule.workingCalendar.weekend.join(', ') || 'none'} · ${schedule.workingCalendar.holidays.length} holidays` },
            { term: 'Critical path', value: schedule.criticalPath.length > 0 ? schedule.criticalPath.join(' → ') : null },
            { term: 'Baseline', value: schedule.baseline ? `v${schedule.baseline.version} · finish ${schedule.baseline.computedFinish ? formatDateLabel(schedule.baseline.computedFinish) : 'unknown'}` : 'none' },
          ]}
        />
        {schedule.range ? (
          <p className="text-xs text-fg-muted">
            Scenario range (not a promise): {formatDateLabel(schedule.range.minBasedCompletionDate)} to {formatDateLabel(schedule.range.maxBasedCompletionDate)}; expected {formatDateLabel(schedule.range.expectedBasedCompletionDate)}.
            {schedule.range.tasksWithoutRange.length > 0 ? ` Tasks without a range: ${schedule.range.tasksWithoutRange.join(', ')}.` : ''}
          </p>
        ) : null}
        {schedule.missingInputs.length > 0 ? (
          <Alert tone="warning" title="Missing inputs">
            <ul className="list-disc pl-5">
              {schedule.missingInputs.map((m) => (
                <li key={`${m.taskKey}-${m.reason}`}>
                  <strong>{m.taskKey}</strong>: {humanize(m.reason)} — {m.detail}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {schedule.baselines.length > 0 ? (
          <p className="text-xs text-fg-muted">
            Baselines: {schedule.baselines.map((b) => <Badge key={b.id} tone="neutral" className="mr-1">v{b.version} {b.reason ? `· ${b.reason}` : ''}</Badge>)}
          </p>
        ) : null}
      </Section>
      <Section title={`Tasks (${schedule.tasks.length})`} description="Replacing the schedule stores a new version and baseline; recording actuals updates one task in place.">
        <ScheduleEditor projectId={p.id} schedule={schedule} editable={shell.permissions.manage} projectStartDate={p.startDate} />
      </Section>
    </div>
  );
}
