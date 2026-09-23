/**
 * Minimal declarative state machine used by every workflow. Transitions are
 * explicit, permission-tagged and may require a reason. The database stores
 * the current state; the transition log is append-only.
 */

export type ActorKind = 'customer' | 'staff' | 'partner' | 'tenant' | 'system';

export interface TransitionRule<S extends string> {
  from: S | S[];
  to: S;
  /** Who may perform this transition. */
  by: ActorKind[];
  /** Permission label checked by the application layer. */
  permission?: string;
  reasonRequired?: boolean;
  /** Human description of billing or side effects. */
  effect?: string;
}

export interface MachineDefinition<S extends string> {
  name: string;
  initial: S;
  states: readonly S[];
  terminal: readonly S[];
  transitions: Array<TransitionRule<S>>;
}

export type TransitionResult<S extends string> =
  | { ok: true; from: S; to: S; rule: TransitionRule<S> }
  | {
      ok: false;
      from: S;
      to: S;
      code: 'invalid_transition' | 'actor_not_allowed' | 'reason_required' | 'terminal_state';
      message: string;
    };

export interface TransitionRequest<S extends string> {
  from: S;
  to: S;
  actor: ActorKind;
  reason?: string | null;
}

export function defineMachine<S extends string>(def: MachineDefinition<S>): MachineDefinition<S> {
  for (const t of def.transitions) {
    const froms = Array.isArray(t.from) ? t.from : [t.from];
    for (const f of froms) {
      if (!def.states.includes(f)) throw new Error(`${def.name}: unknown state ${f}`);
    }
    if (!def.states.includes(t.to)) throw new Error(`${def.name}: unknown state ${t.to}`);
  }
  return def;
}

export function findRule<S extends string>(
  def: MachineDefinition<S>,
  from: S,
  to: S,
): TransitionRule<S> | undefined {
  return def.transitions.find(
    (t) => (Array.isArray(t.from) ? t.from.includes(from) : t.from === from) && t.to === to,
  );
}

export function evaluateTransition<S extends string>(
  def: MachineDefinition<S>,
  req: TransitionRequest<S>,
): TransitionResult<S> {
  const { from, to, actor, reason } = req;
  if (def.terminal.includes(from)) {
    return {
      ok: false,
      from,
      to,
      code: 'terminal_state',
      message: `${def.name}: ${from} is terminal`,
    };
  }
  const rule = findRule(def, from, to);
  if (!rule) {
    return {
      ok: false,
      from,
      to,
      code: 'invalid_transition',
      message: `${def.name}: cannot move from ${from} to ${to}`,
    };
  }
  if (!rule.by.includes(actor)) {
    return {
      ok: false,
      from,
      to,
      code: 'actor_not_allowed',
      message: `${def.name}: ${actor} may not move ${from} to ${to}`,
    };
  }
  if (rule.reasonRequired && !(reason && reason.trim().length > 0)) {
    return {
      ok: false,
      from,
      to,
      code: 'reason_required',
      message: `${def.name}: a reason is required to move ${from} to ${to}`,
    };
  }
  return { ok: true, from, to, rule };
}

export function availableTransitions<S extends string>(
  def: MachineDefinition<S>,
  from: S,
  actor: ActorKind,
): Array<TransitionRule<S>> {
  if (def.terminal.includes(from)) return [];
  return def.transitions.filter(
    (t) =>
      (Array.isArray(t.from) ? t.from.includes(from) : t.from === from) && t.by.includes(actor),
  );
}
