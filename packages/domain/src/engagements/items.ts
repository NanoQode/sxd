/**
 * Engagement items (brief §8): the structured records that make a service
 * engagement inspectable — the due-diligence document checklist, survey
 * references, site findings, queries and red flags; purchase conditions,
 * closing tasks and document handover; land-transaction lease milestones.
 *
 * Everything here is pure. The web service (apps/web/src/server/engagements)
 * loads rows, classifies the caller and asks these functions what is allowed.
 *
 * Per-kind behaviour is data: `ENGAGEMENT_ITEM_KIND_RULES` holds one
 * `KindRule` per kind. A workflow that needs different behaviour for its
 * kind (for example closing tasks that need evidence before they count as
 * satisfied) changes that kind's rule here; the service, API and interfaces
 * pick it up without new code paths.
 */

export const ENGAGEMENT_ITEM_KINDS = [
  'document_check',
  'survey_reference',
  'site_finding',
  'query',
  'red_flag',
  'condition',
  'closing_task',
  'handover_document',
  'lease_milestone',
] as const;
export type EngagementItemKind = (typeof ENGAGEMENT_ITEM_KINDS)[number];

export const ENGAGEMENT_ITEM_STATUSES = [
  'open',
  'in_progress',
  'satisfied',
  'waived',
  'failed',
  'cancelled',
] as const;
export type EngagementItemStatus = (typeof ENGAGEMENT_ITEM_STATUSES)[number];

export const ENGAGEMENT_ITEM_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type EngagementItemSeverity = (typeof ENGAGEMENT_ITEM_SEVERITIES)[number];

export type ItemVisibility = 'internal' | 'customer' | 'partner' | 'all';

/** Statuses that close an item (resolution fields are recorded). */
export const RESOLVED_ITEM_STATUSES: readonly EngagementItemStatus[] = [
  'satisfied',
  'waived',
  'failed',
  'cancelled',
];

/** Statuses in which the customer or an assignee may still add input. */
export const OPEN_ITEM_STATUSES: readonly EngagementItemStatus[] = ['open', 'in_progress'];

export interface KindRule {
  label: string;
  pluralLabel: string;
  /** A severity must be set at creation and can never be cleared. */
  severityRequired: boolean;
  /** `reference` (plan number, registry entry, instrument number) must be set before `satisfied`. */
  referenceRequiredToSatisfy: boolean;
  /** At least one evidence file must be attached before `satisfied`. */
  evidenceRequiredToSatisfy: boolean;
  /** Customers may answer the item (a response note) while it is open. */
  customerMayRespond: boolean;
  /** Customers may upload documents against the item while it is open. */
  customerMayAttach: boolean;
  /** The customer organisation is notified when a customer-visible item of this kind is created. */
  notifyCustomerOnCreate: boolean;
  /** Visibility used when the creator does not choose one. */
  defaultVisibility: ItemVisibility;
  /**
   * Staff permissions (besides the service-request manage permissions) that
   * may create items of this kind, e.g. inspectors recording site findings.
   */
  extraCreatePermissions: readonly string[];
}

const BASE: KindRule = {
  label: 'Item',
  pluralLabel: 'Items',
  severityRequired: false,
  referenceRequiredToSatisfy: false,
  evidenceRequiredToSatisfy: false,
  customerMayRespond: false,
  customerMayAttach: false,
  notifyCustomerOnCreate: false,
  defaultVisibility: 'customer',
  extraCreatePermissions: [],
};

export const ENGAGEMENT_ITEM_KIND_RULES: Record<EngagementItemKind, KindRule> = {
  document_check: {
    ...BASE,
    label: 'Document check',
    pluralLabel: 'Title and document checklist',
    evidenceRequiredToSatisfy: true,
    customerMayAttach: true,
  },
  survey_reference: {
    ...BASE,
    label: 'Survey reference',
    pluralLabel: 'Survey references',
    referenceRequiredToSatisfy: true,
  },
  site_finding: {
    ...BASE,
    label: 'Site finding',
    pluralLabel: 'Site findings',
    severityRequired: true,
    extraCreatePermissions: ['site_visits.perform'],
  },
  query: {
    ...BASE,
    label: 'Query',
    pluralLabel: 'Queries',
    customerMayRespond: true,
    customerMayAttach: true,
    notifyCustomerOnCreate: true,
  },
  red_flag: {
    ...BASE,
    label: 'Red flag',
    pluralLabel: 'Red flags',
    severityRequired: true,
    notifyCustomerOnCreate: true,
  },
  condition: { ...BASE, label: 'Condition', pluralLabel: 'Conditions' },
  closing_task: {
    ...BASE,
    label: 'Closing task',
    pluralLabel: 'Closing checklist',
    defaultVisibility: 'all',
  },
  handover_document: {
    ...BASE,
    label: 'Handover document',
    pluralLabel: 'Document handover',
    evidenceRequiredToSatisfy: true,
    customerMayAttach: true,
  },
  lease_milestone: { ...BASE, label: 'Lease milestone', pluralLabel: 'Lease milestones' },
};

export function kindRule(kind: EngagementItemKind): KindRule {
  return ENGAGEMENT_ITEM_KIND_RULES[kind];
}

export function customerCanSee(visibility: ItemVisibility): boolean {
  return visibility === 'customer' || visibility === 'all';
}

export function partnerCanSee(visibility: ItemVisibility): boolean {
  return visibility === 'partner' || visibility === 'all';
}

export const SEVERITY_RANK: Record<EngagementItemSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function highestSeverity(
  severities: Array<EngagementItemSeverity | null | undefined>,
): EngagementItemSeverity | null {
  let best: EngagementItemSeverity | null = null;
  for (const s of severities) {
    if (s && (best === null || SEVERITY_RANK[s] > SEVERITY_RANK[best])) best = s;
  }
  return best;
}

/* ---------------------------------------------------------------------- */
/* Field validation                                                        */
/* ---------------------------------------------------------------------- */

export interface ItemFieldProblem {
  path: string;
  message: string;
}

/** Validates the fields an item will have after a create or update. */
export function validateItemFields(item: {
  kind: EngagementItemKind;
  title: string;
  severity: EngagementItemSeverity | null;
  visibility: ItemVisibility;
}): ItemFieldProblem[] {
  const rule = kindRule(item.kind);
  const problems: ItemFieldProblem[] = [];
  if (item.title.trim().length === 0) problems.push({ path: 'title', message: 'required' });
  if (rule.severityRequired && !item.severity) {
    problems.push({
      path: 'severity',
      message: `a severity is required for ${rule.label.toLowerCase()} items`,
    });
  }
  return problems;
}

/* ---------------------------------------------------------------------- */
/* Status transitions                                                      */
/* ---------------------------------------------------------------------- */

/**
 * Who is moving the item:
 * - `manager`: staff who manage the service request (triage/project management);
 * - `assignee`: the professional the item is assigned to (partner or staff);
 * - `customer`: a member of the customer organisation (never moves status
 *   directly; answering or uploading marks an open item in progress).
 */
export type ItemActor = 'manager' | 'assignee' | 'customer';

interface ItemTransitionRule {
  from: readonly EngagementItemStatus[];
  to: EngagementItemStatus;
  by: readonly ItemActor[];
  reasonRequired: boolean;
}

const ANY_OPEN: readonly EngagementItemStatus[] = ['open', 'in_progress'];

export const ENGAGEMENT_ITEM_TRANSITIONS: readonly ItemTransitionRule[] = [
  { from: ['open'], to: 'in_progress', by: ['manager', 'assignee'], reasonRequired: false },
  { from: ['in_progress'], to: 'open', by: ['manager', 'assignee'], reasonRequired: false },
  { from: ANY_OPEN, to: 'satisfied', by: ['manager', 'assignee'], reasonRequired: false },
  // Recording that a check failed is a professional finding; it needs the why.
  { from: ANY_OPEN, to: 'failed', by: ['manager', 'assignee'], reasonRequired: true },
  // Waiving or cancelling changes the scope of the engagement: staff only, with a reason.
  { from: ANY_OPEN, to: 'waived', by: ['manager'], reasonRequired: true },
  { from: ANY_OPEN, to: 'cancelled', by: ['manager'], reasonRequired: true },
  // Reopening a closed item is always explained.
  {
    from: ['satisfied', 'failed'],
    to: 'in_progress',
    by: ['manager', 'assignee'],
    reasonRequired: true,
  },
  { from: ['waived', 'failed'], to: 'open', by: ['manager'], reasonRequired: true },
];

export type ItemTransitionCheck =
  | { ok: true; resolves: boolean; reopens: boolean }
  | {
      ok: false;
      code:
        | 'invalid_transition'
        | 'actor_not_allowed'
        | 'reason_required'
        | 'reference_required'
        | 'evidence_required'
        | 'terminal_state';
      message: string;
    };

export interface ItemTransitionInput {
  kind: EngagementItemKind;
  from: EngagementItemStatus;
  to: EngagementItemStatus;
  actor: ItemActor;
  reason?: string | null;
  reference?: string | null;
  evidenceCount: number;
}

export function evaluateItemTransition(input: ItemTransitionInput): ItemTransitionCheck {
  const { kind, from, to, actor } = input;
  const rule = kindRule(kind);
  if (from === 'cancelled') {
    return { ok: false, code: 'terminal_state', message: 'a cancelled item cannot change' };
  }
  const t = ENGAGEMENT_ITEM_TRANSITIONS.find((r) => r.to === to && r.from.includes(from));
  if (!t) {
    return {
      ok: false,
      code: 'invalid_transition',
      message: `cannot move a ${rule.label.toLowerCase()} from ${from} to ${to}`,
    };
  }
  if (!t.by.includes(actor)) {
    return {
      ok: false,
      code: 'actor_not_allowed',
      message:
        actor === 'customer'
          ? 'customers answer queries and upload documents; staff decide the status'
          : `only staff managing the request may move an item to ${to}`,
    };
  }
  if (t.reasonRequired && !(input.reason && input.reason.trim().length > 0)) {
    return {
      ok: false,
      code: 'reason_required',
      message: `a reason is required to move an item from ${from} to ${to}`,
    };
  }
  if (to === 'satisfied') {
    if (rule.referenceRequiredToSatisfy && !(input.reference && input.reference.trim())) {
      return {
        ok: false,
        code: 'reference_required',
        message: `record the reference (plan or registry number) before marking this ${rule.label.toLowerCase()} satisfied`,
      };
    }
    if (rule.evidenceRequiredToSatisfy && input.evidenceCount === 0) {
      return {
        ok: false,
        code: 'evidence_required',
        message: `attach the evidence before marking this ${rule.label.toLowerCase()} satisfied`,
      };
    }
  }
  const resolves = RESOLVED_ITEM_STATUSES.includes(to);
  const reopens = RESOLVED_ITEM_STATUSES.includes(from) && !resolves;
  return { ok: true, resolves, reopens };
}

/** Targets the actor may choose from `from` (for rendering only working controls). */
export function availableItemTransitions(
  from: EngagementItemStatus,
  actor: ItemActor,
): Array<{ to: EngagementItemStatus; reasonRequired: boolean }> {
  if (from === 'cancelled') return [];
  return ENGAGEMENT_ITEM_TRANSITIONS.filter((t) => t.from.includes(from) && t.by.includes(actor)).map(
    (t) => ({ to: t.to, reasonRequired: t.reasonRequired }),
  );
}

/* ---------------------------------------------------------------------- */
/* Customer input                                                          */
/* ---------------------------------------------------------------------- */

export type CustomerInputCheck = { ok: true } | { ok: false; message: string };

/** Whether a customer may answer this item (a query they can see, still open). */
export function customerMayRespond(item: {
  kind: EngagementItemKind;
  visibility: ItemVisibility;
  status: EngagementItemStatus;
}): CustomerInputCheck {
  const rule = kindRule(item.kind);
  if (!rule.customerMayRespond)
    return { ok: false, message: `customers do not answer ${rule.pluralLabel.toLowerCase()}` };
  if (!customerCanSee(item.visibility)) return { ok: false, message: 'item not found' };
  if (!OPEN_ITEM_STATUSES.includes(item.status))
    return { ok: false, message: `this ${rule.label.toLowerCase()} is already ${item.status}` };
  return { ok: true };
}

/** Whether a customer may upload documents against this item. */
export function customerMayAttach(item: {
  kind: EngagementItemKind;
  visibility: ItemVisibility;
  status: EngagementItemStatus;
}): CustomerInputCheck {
  const rule = kindRule(item.kind);
  if (!rule.customerMayAttach)
    return {
      ok: false,
      message: `customers do not upload documents against ${rule.pluralLabel.toLowerCase()}`,
    };
  if (!customerCanSee(item.visibility)) return { ok: false, message: 'item not found' };
  if (!OPEN_ITEM_STATUSES.includes(item.status))
    return { ok: false, message: `this ${rule.label.toLowerCase()} is already ${item.status}` };
  return { ok: true };
}

/**
 * Customer input (an answer or a document) moves an open item to
 * in_progress so staff see it needs checking; anything else is unchanged.
 */
export function statusAfterCustomerInput(status: EngagementItemStatus): EngagementItemStatus {
  return status === 'open' ? 'in_progress' : status;
}

/* ---------------------------------------------------------------------- */
/* Summaries                                                               */
/* ---------------------------------------------------------------------- */

export interface ItemSummaryInput {
  kind: EngagementItemKind;
  status: EngagementItemStatus;
  severity: EngagementItemSeverity | null;
  visibility: ItemVisibility;
}

export interface ItemSummary {
  total: number;
  open: number;
  resolved: number;
  byKind: Partial<Record<EngagementItemKind, { total: number; open: number }>>;
  redFlags: { open: number; total: number; highestOpenSeverity: EngagementItemSeverity | null };
  /** Customer-visible queries still open (the customer's to-do list). */
  openCustomerQueries: number;
  /** Customer-visible document checks still open that accept customer uploads. */
  openDocumentRequests: number;
}

export function summarizeItems(items: readonly ItemSummaryInput[]): ItemSummary {
  const byKind: ItemSummary['byKind'] = {};
  let open = 0;
  let redOpen = 0;
  let redTotal = 0;
  let queries = 0;
  let docs = 0;
  const openRedSeverities: Array<EngagementItemSeverity | null> = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const isOpen = OPEN_ITEM_STATUSES.includes(item.status);
    const k = (byKind[item.kind] ??= { total: 0, open: 0 });
    k.total += 1;
    if (isOpen) {
      k.open += 1;
      open += 1;
    }
    if (item.kind === 'red_flag') {
      redTotal += 1;
      if (isOpen) {
        redOpen += 1;
        openRedSeverities.push(item.severity);
      }
    }
    if (isOpen && customerCanSee(item.visibility)) {
      if (item.kind === 'query') queries += 1;
      if (item.kind === 'document_check' && kindRule(item.kind).customerMayAttach) docs += 1;
    }
  }
  const counted = items.filter((i) => i.status !== 'cancelled').length;
  return {
    total: counted,
    open,
    resolved: counted - open,
    byKind,
    redFlags: {
      open: redOpen,
      total: redTotal,
      highestOpenSeverity: highestSeverity(openRedSeverities),
    },
    openCustomerQueries: queries,
    openDocumentRequests: docs,
  };
}
