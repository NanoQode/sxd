import type { PartnerIdentity } from './context';

/**
 * Which workspace modules a signed-in partner or inspector sees. This is for
 * clarity only: every page and endpoint enforces its own permission, so a
 * hidden module is never the only thing standing between a user and data.
 *
 * - Contractors and design/cost professionals bid on tenders. Contractors'
 *   awarded work arrives as assignments, whose cards link to that project's
 *   visits, evidence and reports.
 * - Vendors quote on RFQs and deliver purchase orders.
 * - Field roles (staff inspectors, inspector/surveyor/valuer partners and the
 *   professionals staff send to site) capture visits.
 * - Legal and survey partners see assigned evidence, findings and reports.
 * - Expansion modules behind a feature flag are hidden while the flag is off.
 */

export type PartnerModule =
  | 'home'
  | 'assignments'
  | 'tenders'
  | 'rfqs'
  | 'visits'
  | 'evidence'
  | 'reports'
  | 'messages'
  | 'notifications'
  | 'availability';

const TENDER_TYPES = new Set(['contractor', 'architect', 'quantity_surveyor', 'other']);
const SUPPLY_TYPES = new Set(['vendor', 'other']);
const FIELD_TYPES = new Set([
  'inspector',
  'surveyor',
  'valuer',
  'architect',
  'quantity_surveyor',
  'other',
]);
const EVIDENCE_TYPES = new Set([...FIELD_TYPES, 'legal']);

type NavIdentity = Pick<
  PartnerIdentity,
  'isPartner' | 'partnerType' | 'isStaffInspector' | 'flags'
>;

export function partnerModules(p: NavIdentity): Set<PartnerModule> {
  const type = p.isPartner ? (p.partnerType ?? 'other') : null;
  const out = new Set<PartnerModule>(['home', 'assignments', 'messages', 'notifications']);
  if (type && TENDER_TYPES.has(type) && p.flags.tendering) out.add('tenders');
  if (type && SUPPLY_TYPES.has(type) && p.flags.procurement) out.add('rfqs');
  const field = p.isStaffInspector || (type !== null && FIELD_TYPES.has(type));
  if (field) out.add('visits');
  if (field || (type !== null && EVIDENCE_TYPES.has(type))) {
    out.add('evidence');
    out.add('reports');
  }
  // Staff without a partner profile who hold only an assignment still see the
  // project work they were given.
  if (!p.isPartner && !p.isStaffInspector) {
    out.add('evidence');
    out.add('reports');
  }
  out.add('availability');
  return out;
}
