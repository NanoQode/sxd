import { defineMachine, evaluateTransition, type ActorKind } from '../workflow/machine';

/**
 * Purchase representation (build brief §8): offers and their negotiation
 * log, conditions, the diligence dependency, the closing checklist and
 * document handover. Pure rules shared by the web services and tests.
 */

/* ---------------------------------------------------------------------- */
/* Offers                                                                  */
/* ---------------------------------------------------------------------- */

export const OFFER_STATES = [
  'draft',
  'submitted',
  'countered',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
] as const;
export type OfferState = (typeof OFFER_STATES)[number];

/**
 * Offer lifecycle for a buyer represented by SimplexD. The seller's side
 * (counter, acceptance, rejection) is recorded by staff acting as the
 * representative; committing the buyer (submitting, accepting a counter)
 * needs the customer's authority or staff acting on a recorded instruction
 * (a reason is then required, see `offerActionRule`).
 */
export const offerMachine = defineMachine<OfferState>({
  name: 'offer',
  initial: 'draft',
  states: OFFER_STATES,
  terminal: ['accepted', 'rejected', 'withdrawn', 'expired'],
  transitions: [
    {
      from: 'draft',
      to: 'submitted',
      by: ['customer', 'staff'],
      effect: 'The offer is put to the seller.',
    },
    {
      from: 'draft',
      to: 'withdrawn',
      by: ['customer', 'staff'],
      effect: 'The draft is discarded.',
    },
    {
      from: 'submitted',
      to: 'countered',
      by: ['staff'],
      effect: "The seller's counter-offer is recorded.",
    },
    {
      from: 'submitted',
      to: 'accepted',
      by: ['staff'],
      effect: 'The seller accepted the offer.',
    },
    {
      from: ['submitted', 'countered'],
      to: 'rejected',
      by: ['staff'],
      reasonRequired: true,
      effect: 'The seller rejected the offer.',
    },
    {
      from: ['submitted', 'countered'],
      to: 'withdrawn',
      by: ['customer', 'staff'],
      reasonRequired: true,
      effect: 'The buyer withdrew.',
    },
    {
      from: 'countered',
      to: 'submitted',
      by: ['customer', 'staff'],
      effect: "The buyer's revised offer is put to the seller.",
    },
    {
      from: 'countered',
      to: 'accepted',
      by: ['customer', 'staff'],
      effect: "The buyer accepted the seller's counter-offer.",
    },
    {
      from: ['submitted', 'countered'],
      to: 'expired',
      by: ['staff', 'system'],
      effect: 'The offer lapsed without agreement.',
    },
  ],
});

export const OFFER_ACTIONS = [
  'submit',
  'counter',
  'revise',
  'accept',
  'reject',
  'withdraw',
  'expire',
  'note',
] as const;
export type OfferAction = (typeof OFFER_ACTIONS)[number];

/**
 * The state an action moves the offer to (null: a note, no state change). A
 * revision is only valid from `countered`; `checkOfferAction` enforces it.
 */
export function offerActionTarget(action: OfferAction): OfferState | null {
  switch (action) {
    case 'submit':
    case 'revise':
      return 'submitted';
    case 'counter':
      return 'countered';
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
    case 'withdraw':
      return 'withdrawn';
    case 'expire':
      return 'expired';
    case 'note':
      return null;
  }
}

export interface OfferActionCheck {
  ok: boolean;
  to: OfferState | null;
  code?: 'invalid_transition' | 'actor_not_allowed' | 'reason_required' | 'amount_required';
  message?: string;
}

/**
 * Validates an offer action: the state machine decides validity; amounts are
 * required for a counter-offer and a revised offer; staff committing the
 * buyer (submit, revise, accept a counter) must cite the customer's
 * instruction in the note.
 */
export function checkOfferAction(input: {
  from: OfferState;
  action: OfferAction;
  actor: ActorKind;
  amountKobo?: bigint | null;
  note?: string | null;
}): OfferActionCheck {
  const to = offerActionTarget(input.action);
  if (to === null) {
    if (!input.note || !input.note.trim()) {
      return { ok: false, to, code: 'reason_required', message: 'a note needs text' };
    }
    return { ok: true, to };
  }
  if (input.action === 'revise' && input.from !== 'countered') {
    return {
      ok: false,
      to,
      code: 'invalid_transition',
      message: 'offer: only a countered offer can be revised',
    };
  }
  if (input.action === 'submit' && input.from !== 'draft') {
    return {
      ok: false,
      to,
      code: 'invalid_transition',
      message: `offer: cannot submit an offer that is ${input.from}`,
    };
  }
  const decision = evaluateTransition(offerMachine, {
    from: input.from,
    to,
    actor: input.actor,
    reason: input.note ?? null,
  });
  if (!decision.ok) {
    return {
      ok: false,
      to,
      code: decision.code === 'terminal_state' ? 'invalid_transition' : decision.code,
      message: decision.message,
    };
  }
  if ((input.action === 'counter' || input.action === 'revise') && !input.amountKobo) {
    return {
      ok: false,
      to,
      code: 'amount_required',
      message: `offer: ${input.action === 'counter' ? 'a counter-offer' : 'a revised offer'} needs an amount`,
    };
  }
  if (input.amountKobo !== undefined && input.amountKobo !== null && input.amountKobo <= 0n) {
    return { ok: false, to, code: 'amount_required', message: 'offer: amount must be positive' };
  }
  const commitsBuyer =
    input.action === 'submit' ||
    input.action === 'revise' ||
    (input.action === 'accept' && input.from === 'countered');
  if (commitsBuyer && input.actor === 'staff' && !(input.note && input.note.trim().length >= 3)) {
    return {
      ok: false,
      to,
      code: 'reason_required',
      message: "offer: staff acting for the buyer must record the customer's instruction",
    };
  }
  return { ok: true, to };
}

/* ---------------------------------------------------------------------- */
/* Negotiation log                                                         */
/* ---------------------------------------------------------------------- */

export interface NegotiationEntry {
  at: string;
  byUserId: string | null;
  action: string;
  amountKobo?: string;
  note?: string;
  /** Status after the entry (absent for notes). */
  status?: OfferState;
  /** Who acted: customer, staff or system. */
  actor?: ActorKind;
}

export class NegotiationLogTamperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NegotiationLogTamperError';
  }
}

function sameEntry(a: NegotiationEntry, b: NegotiationEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Asserts that `next` extends `previous` without changing or removing any
 * earlier entry. The negotiation log is append-only: corrections are new
 * entries.
 */
export function assertAppendOnly(previous: NegotiationEntry[], next: NegotiationEntry[]): void {
  if (next.length < previous.length) {
    throw new NegotiationLogTamperError('negotiation log entries cannot be removed');
  }
  for (let i = 0; i < previous.length; i += 1) {
    if (!sameEntry(previous[i]!, next[i]!)) {
      throw new NegotiationLogTamperError(`negotiation log entry ${i} cannot be changed`);
    }
  }
}

/** Returns a new log with the entry appended (the input is not mutated). */
export function appendNegotiationEntry(
  log: readonly NegotiationEntry[],
  entry: NegotiationEntry,
): NegotiationEntry[] {
  const next = [...log, entry];
  assertAppendOnly([...log], next);
  return next;
}

/** Parses a stored log defensively (unknown shapes are dropped, never invented). */
export function parseNegotiationLog(raw: unknown): NegotiationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is NegotiationEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as NegotiationEntry).at === 'string' &&
      typeof (e as NegotiationEntry).action === 'string',
  );
}

/* ---------------------------------------------------------------------- */
/* Conditions, closing checklist, handover and diligence                   */
/* ---------------------------------------------------------------------- */

export const OPEN_ITEM_STATUSES = ['open', 'in_progress'] as const;
/** Red flags block closing while open, in progress or failed (not resolved). */
export const BLOCKING_RED_FLAG_STATUSES = ['open', 'in_progress', 'failed'] as const;

export interface ItemState {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'satisfied' | 'waived' | 'failed' | 'cancelled';
  fileCount?: number;
}

export interface DiligenceState {
  /** The linked due-diligence request, when any. */
  linked: boolean;
  /** Staff waived the dependency (with a recorded reason). */
  waived: boolean;
  /** Unresolved red flags on the linked request. */
  openRedFlags: number;
  /** A diligence memorandum has been released to the customer. */
  memoReleased: boolean;
  /** The linked request is cancelled or rejected. */
  requestClosedWithoutDelivery?: boolean;
}

export type ClosingBlockerCode =
  | 'no_accepted_offer'
  | 'conditions_open'
  | 'conditions_failed'
  | 'diligence_not_linked'
  | 'diligence_red_flags_open'
  | 'diligence_memo_not_released'
  | 'diligence_request_closed'
  | 'closing_tasks_open'
  | 'handover_documents_missing_files'
  | 'handover_not_acknowledged'
  | 'fee_basis_not_agreed';

export interface ClosingBlocker {
  code: ClosingBlockerCode;
  message: string;
  itemIds?: string[];
}

export interface DiligenceCheck {
  clear: boolean;
  blockers: ClosingBlocker[];
}

/** The diligence dependency alone (also shown on its own card). */
export function checkDiligence(d: DiligenceState): DiligenceCheck {
  if (d.waived) return { clear: true, blockers: [] };
  const blockers: ClosingBlocker[] = [];
  if (!d.linked) {
    blockers.push({
      code: 'diligence_not_linked',
      message: 'Link the due-diligence request for this purchase (or record a waiver).',
    });
    return { clear: false, blockers };
  }
  if (d.requestClosedWithoutDelivery) {
    blockers.push({
      code: 'diligence_request_closed',
      message: 'The linked due-diligence request was cancelled or rejected.',
    });
  }
  if (d.openRedFlags > 0) {
    blockers.push({
      code: 'diligence_red_flags_open',
      message: `${d.openRedFlags} diligence red flag${d.openRedFlags === 1 ? ' is' : 's are'} unresolved.`,
    });
  }
  if (!d.memoReleased) {
    blockers.push({
      code: 'diligence_memo_not_released',
      message: 'No reviewed diligence memorandum has been released yet.',
    });
  }
  return { clear: blockers.length === 0, blockers };
}

export interface ClosingInput {
  acceptedOfferId: string | null;
  conditions: ItemState[];
  diligence: DiligenceState;
  closingTasks: ItemState[];
  handoverDocuments: Array<ItemState & { acknowledged: boolean }>;
  feeBasisAgreed: boolean;
}

export interface ClosingReadiness {
  ready: boolean;
  blockers: ClosingBlocker[];
}

const resolved = (s: ItemState['status']) =>
  s === 'satisfied' || s === 'waived' || s === 'cancelled';

/**
 * Closing is allowed only when an offer was accepted, every condition is
 * satisfied or waived, the diligence dependency is clear, every closing task
 * is done, every handover document has files and the customer acknowledged
 * receipt, and the fee basis was agreed.
 */
export function closingReadiness(input: ClosingInput): ClosingReadiness {
  const blockers: ClosingBlocker[] = [];
  if (!input.acceptedOfferId) {
    blockers.push({ code: 'no_accepted_offer', message: 'No offer has been accepted yet.' });
  }
  const failed = input.conditions.filter((c) => c.status === 'failed');
  if (failed.length > 0) {
    blockers.push({
      code: 'conditions_failed',
      message: `${failed.length} condition${failed.length === 1 ? ' has' : 's have'} failed; waive with a reason or renegotiate.`,
      itemIds: failed.map((c) => c.id),
    });
  }
  const openConditions = input.conditions.filter(
    (c) => c.status === 'open' || c.status === 'in_progress',
  );
  if (openConditions.length > 0) {
    blockers.push({
      code: 'conditions_open',
      message: `${openConditions.length} condition${openConditions.length === 1 ? ' is' : 's are'} still open.`,
      itemIds: openConditions.map((c) => c.id),
    });
  }
  blockers.push(...checkDiligence(input.diligence).blockers);
  const openTasks = input.closingTasks.filter((t) => !resolved(t.status));
  if (openTasks.length > 0) {
    blockers.push({
      code: 'closing_tasks_open',
      message: `${openTasks.length} closing task${openTasks.length === 1 ? ' is' : 's are'} not done.`,
      itemIds: openTasks.map((t) => t.id),
    });
  }
  const live = input.handoverDocuments.filter((d) => d.status !== 'cancelled' && d.status !== 'waived');
  const noFiles = live.filter((d) => (d.fileCount ?? 0) === 0);
  if (noFiles.length > 0) {
    blockers.push({
      code: 'handover_documents_missing_files',
      message: `${noFiles.length} handover document${noFiles.length === 1 ? ' has' : 's have'} no file attached.`,
      itemIds: noFiles.map((d) => d.id),
    });
  }
  const unacknowledged = live.filter((d) => (d.fileCount ?? 0) > 0 && !d.acknowledged);
  if (unacknowledged.length > 0) {
    blockers.push({
      code: 'handover_not_acknowledged',
      message: `The customer has not acknowledged ${unacknowledged.length} handover document${unacknowledged.length === 1 ? '' : 's'}.`,
      itemIds: unacknowledged.map((d) => d.id),
    });
  }
  if (!input.feeBasisAgreed) {
    blockers.push({
      code: 'fee_basis_not_agreed',
      message:
        'The purchase-support fee basis has not been agreed (accepted percentage quote with an agreed basis amount and signed scope).',
    });
  }
  return { ready: blockers.length === 0, blockers };
}

/** Engagement item kinds used by purchase representation. */
export const PURCHASE_ITEM_KINDS = ['condition', 'closing_task', 'handover_document'] as const;
export type PurchaseItemKind = (typeof PURCHASE_ITEM_KINDS)[number];

/** Subject type of the engagement item that links the due-diligence request. */
export const DILIGENCE_LINK_SUBJECT = 'diligence_request';
/** Resolution note recorded when the customer acknowledges a handover document. */
export const HANDOVER_ACK_NOTE = 'Receipt acknowledged by the customer';
