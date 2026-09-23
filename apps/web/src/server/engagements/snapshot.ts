import 'server-only';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { schema, type Transaction } from '@simplexd/db';
import {
  kindRule,
  type EngagementItemKind,
  type EngagementItemSeverity,
  type EngagementItemStatus,
  type TemplateSection,
} from '@simplexd/domain/engagements';

/**
 * Structured content stored on the revisions of reports written under a
 * service request (`report_revisions.findings`). The template outline and a
 * frozen snapshot of the customer-visible engagement items are captured with
 * every revision, so a released version always shows exactly the red flags,
 * findings, checklist status and evidence references its reviewer approved.
 */

export interface ItemSnapshotEvidence {
  fileId: string;
  name: string;
  checksumSha256: string | null;
  sizeBytes: number | null;
}

export interface ItemSnapshot {
  id: string;
  kind: EngagementItemKind;
  kindLabel: string;
  title: string;
  detail: string | null;
  reference: string | null;
  status: EngagementItemStatus;
  severity: EngagementItemSeverity | null;
  resolutionNote: string | null;
  evidence: ItemSnapshotEvidence[];
}

export interface TemplateSnapshot {
  id: string | null;
  name: string;
  version: number | null;
  sections: Array<Pick<TemplateSection, 'key' | 'heading' | 'required'>>;
}

export interface EngagementReportFindings {
  template?: TemplateSnapshot;
  /** When true, every new revision re-captures the engagement item snapshot. */
  referenceItems?: boolean;
  engagementItems?: { capturedAt: string; items: ItemSnapshot[] };
  [key: string]: unknown;
}

const RESERVED_KEYS = ['template', 'referenceItems', 'engagementItems'] as const;

export function asEngagementFindings(value: unknown): EngagementReportFindings {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as EngagementReportFindings)
    : {};
}

/**
 * Customer-visible items (visibility customer/all, not cancelled) with their
 * evidence names and checksums. Internal and partner-only items never enter
 * a report automatically; staff restate them in the body if they must.
 */
export async function snapshotEngagementItems(
  tx: Transaction,
  serviceRequestId: string,
): Promise<{ capturedAt: string; items: ItemSnapshot[] }> {
  const rows = await tx
    .select()
    .from(schema.engagementItems)
    .where(
      and(
        eq(schema.engagementItems.serviceRequestId, serviceRequestId),
        inArray(schema.engagementItems.visibility, ['customer', 'all']),
        ne(schema.engagementItems.status, 'cancelled'),
      ),
    )
    .orderBy(asc(schema.engagementItems.sortOrder), asc(schema.engagementItems.createdAt));
  const fileIds = [...new Set(rows.flatMap((r) => r.fileIds ?? []))];
  const files =
    fileIds.length === 0
      ? []
      : await tx
          .select({
            id: schema.fileObjects.id,
            name: schema.fileObjects.originalName,
            checksumSha256: schema.fileObjects.checksumSha256,
            sizeBytes: schema.fileObjects.sizeBytes,
            status: schema.fileObjects.status,
          })
          .from(schema.fileObjects)
          .where(inArray(schema.fileObjects.id, fileIds));
  const byId = new Map(files.map((f) => [f.id, f]));
  return {
    capturedAt: new Date().toISOString(),
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      kindLabel: kindRule(r.kind).label,
      title: r.title,
      detail: r.detail,
      reference: r.reference,
      status: r.status,
      severity: r.severity,
      resolutionNote: r.resolutionNote,
      evidence: (r.fileIds ?? []).flatMap((id) => {
        const f = byId.get(id);
        if (!f || ['infected', 'rejected', 'deleted'].includes(f.status)) return [];
        return [
          {
            fileId: f.id,
            name: f.name,
            checksumSha256: f.checksumSha256 ?? null,
            sizeBytes: f.sizeBytes ?? null,
          },
        ];
      }),
    })),
  };
}

/**
 * Findings for a new revision of a service-request report: the author's own
 * structured findings (reserved keys removed), the template carried forward,
 * and a fresh item snapshot when the report references items.
 */
export async function nextRevisionFindings(
  tx: Transaction,
  serviceRequestId: string,
  previous: unknown,
  authored: unknown,
): Promise<EngagementReportFindings> {
  const prev = asEngagementFindings(previous);
  const own = { ...asEngagementFindings(authored) };
  for (const k of RESERVED_KEYS) delete own[k];
  const out: EngagementReportFindings = { ...own };
  if (prev.template) out.template = prev.template;
  if (prev.referenceItems) {
    out.referenceItems = true;
    out.engagementItems = await snapshotEngagementItems(tx, serviceRequestId);
  }
  return out;
}
