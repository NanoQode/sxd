/**
 * Pure SLA helpers for queues. The SLA due time is set by triage (from
 * sla_policies or an explicit override); these helpers only classify it.
 */

export type SlaState = 'none' | 'ok' | 'due_soon' | 'overdue' | 'stopped';

export interface SlaSummary {
  state: SlaState;
  /** Hours until due (negative when overdue); null without a due time. */
  hoursRemaining: number | null;
  label: string;
}

const PAUSED_STATES = new Set(['paused', 'completed', 'rejected', 'cancelled', 'delivered']);

export function summarizeSla(
  slaDueAt: string | null | undefined,
  status: string,
  now: Date = new Date(),
  dueSoonHours = 8,
): SlaSummary {
  if (PAUSED_STATES.has(status)) {
    return { state: 'stopped', hoursRemaining: null, label: 'Clock stopped' };
  }
  if (!slaDueAt) return { state: 'none', hoursRemaining: null, label: 'No SLA set' };
  const due = new Date(slaDueAt).getTime();
  if (Number.isNaN(due)) return { state: 'none', hoursRemaining: null, label: 'No SLA set' };
  const hours = (due - now.getTime()) / 3_600_000;
  const rounded = Math.round(hours * 10) / 10;
  if (hours < 0) {
    return { state: 'overdue', hoursRemaining: rounded, label: `Overdue by ${fmtHours(-hours)}` };
  }
  if (hours <= dueSoonHours) {
    return { state: 'due_soon', hoursRemaining: rounded, label: `Due in ${fmtHours(hours)}` };
  }
  return { state: 'ok', hoursRemaining: rounded, label: `Due in ${fmtHours(hours)}` };
}

export function fmtHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'P1 · Critical',
  2: 'P2 · High',
  3: 'P3 · Normal',
  4: 'P4 · Low',
  5: 'P5 · Backlog',
};

export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? `P${priority}`;
}
