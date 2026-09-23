import 'server-only';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import {
  ApiError,
  type ReportDetailDto,
  type ReportDto,
  type ReportTemplateOutlineDto,
  type ServiceRequestReportCreate,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { AuthorizationError, authorizeStaff } from '@simplexd/domain/authz';
import {
  FALLBACK_SECTIONS,
  bodyFromSections,
  type ServiceRequestReportKind,
  type TemplateSection,
} from '@simplexd/domain/engagements';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { elevated } from '@/server/files/access';
import type { AccessCheck } from '@/server/projects/access';
import {
  REPORT_READ_CHECKS,
  REQUEST_DRAFT_CHECKS,
  insertReportRevision,
  loadReportScoped,
  reportDetailFor,
} from '@/server/projects/reports';
import {
  ctxFor,
  invalidTransition,
  iso,
  notFound,
  userIdOf,
  type ServiceOptions,
} from '@/server/projects/shared';
import { REQUEST_READ_CHECKS, isRequestCustomer, requireServiceRequest } from './access';
import { renderReportExport, type ExportEvidenceRef } from './export';
import {
  asEngagementFindings,
  snapshotEngagementItems,
  type EngagementReportFindings,
} from './snapshot';

/**
 * Reports written directly under a service request: the due-diligence
 * decision memorandum and the virtual inspection report. They share the
 * project report lifecycle (`@/server/projects/reports`): revisions, a named
 * professional reviewer who is not the author, review and release by
 * someone other than the author. This module adds creation from the active
 * report template of the kind, listing per request and the print-ready
 * export of any released report.
 */

type ReportRow = typeof schema.reports.$inferSelect;

const CLOSED_FOR_NEW_REPORTS = ['cancelled', 'rejected'];

function parseSections(value: unknown): TemplateSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const o = s as Record<string, unknown>;
    if (typeof o['key'] !== 'string' || typeof o['heading'] !== 'string') return [];
    if (o['heading'].trim().length === 0) return [];
    return [
      {
        key: o['key'],
        heading: o['heading'],
        guidance: typeof o['guidance'] === 'string' ? o['guidance'] : undefined,
        required: o['required'] === true,
      },
    ];
  });
}

/**
 * The template to start from: the one named (must be active and of the same
 * kind) or the most recently updated active template of the kind. Without
 * one, a built-in outline of headings is used and the result says so.
 */
async function resolveTemplate(
  tx: Transaction,
  kind: ServiceRequestReportKind,
  templateId?: string,
): Promise<ReportTemplateOutlineDto> {
  const [row] = templateId
    ? await tx
        .select()
        .from(schema.reportTemplates)
        .where(
          and(
            eq(schema.reportTemplates.id, templateId),
            eq(schema.reportTemplates.kind, kind),
            eq(schema.reportTemplates.active, true),
          ),
        )
    : await tx
        .select()
        .from(schema.reportTemplates)
        .where(and(eq(schema.reportTemplates.kind, kind), eq(schema.reportTemplates.active, true)))
        .orderBy(desc(schema.reportTemplates.updatedAt))
        .limit(1);
  if (templateId && !row)
    throw new ApiError('validation_failed', 'the template is not an active template of this kind', {
      details: [{ path: 'templateId', message: 'inactive, missing or of another kind' }],
    });
  const sections = row ? parseSections(row.sections) : [];
  if (!row || sections.length === 0) {
    return {
      id: row?.id ?? null,
      name: row ? `${row.name} (no sections; built-in outline used)` : 'Built-in outline',
      version: row?.version ?? null,
      sections: FALLBACK_SECTIONS[kind].map((s) => ({ ...s, guidance: s.guidance ?? null })),
      limitationsMarkdown: row?.limitationsMarkdown ?? null,
    };
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    sections: sections.map((s) => ({
      key: s.key,
      heading: s.heading,
      guidance: s.guidance ?? null,
      required: s.required,
    })),
    limitationsMarkdown: row.limitationsMarkdown,
  };
}

/** Template outline with author guidance (staff who draft reports only). */
export async function getReportTemplateOutline(
  identity: RequestIdentity,
  kind: ServiceRequestReportKind,
  templateId?: string,
): Promise<ReportTemplateOutlineDto> {
  userIdOf(identity);
  const decision = authorizeStaff(identity.actor, 'reports.draft');
  if (!decision.allowed) {
    const review = authorizeStaff(identity.actor, 'reports.review');
    if (!review.allowed) throw new AuthorizationError(decision);
  }
  return withActor(getDb(), ctxFor(identity), (tx) => resolveTemplate(tx, kind, templateId));
}

/** Draft a decision memorandum or virtual inspection report under a request (staff `reports.draft`). */
export async function createServiceRequestReport(
  identity: RequestIdentity,
  serviceRequestId: string,
  input: ServiceRequestReportCreate,
  options: ServiceOptions = {},
): Promise<ReportDetailDto & { template: ReportTemplateOutlineDto }> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireServiceRequest(
      tx,
      identity,
      serviceRequestId,
      REQUEST_DRAFT_CHECKS,
    );
    if (CLOSED_FOR_NEW_REPORTS.includes(access.sr.status))
      throw invalidTransition(`the request is ${access.sr.status}; no new reports can be drafted`);
    const template = await resolveTemplate(tx, input.kind, input.templateId);
    const own = input.initialRevision;
    const authored = { ...asEngagementFindings(own?.findings ?? null) };
    delete authored.template;
    delete authored.referenceItems;
    delete authored.engagementItems;
    const findings: EngagementReportFindings = {
      ...authored,
      template: {
        id: template.id,
        name: template.name,
        version: template.version,
        sections: template.sections.map(({ key, heading, required }) => ({
          key,
          heading,
          required,
        })),
      },
      referenceItems: input.referenceItems,
      ...(input.referenceItems
        ? { engagementItems: await snapshotEngagementItems(tx, serviceRequestId) }
        : {}),
    };
    const [row] = await tx
      .insert(schema.reports)
      .values({
        organizationId: access.sr.organizationId,
        projectId: null,
        serviceRequestId,
        kind: input.kind,
        title: input.title,
        status: 'draft',
        currentVersion: 1,
        createdBy: actorId,
      })
      .returning();
    await insertReportRevision(
      tx,
      row!.id,
      1,
      {
        summary: own?.summary ?? null,
        bodyMarkdown:
          own?.bodyMarkdown ??
          bodyFromSections(
            template.sections.map(({ key, heading, required }) => ({ key, heading, required })),
          ),
        findings: findings as never,
        attachmentFileIds: own?.attachmentFileIds ?? [],
        scopeLimitations: own?.scopeLimitations ?? template.limitationsMarkdown ?? null,
      },
      actorId,
    );
    await recordAudit(tx, identity, {
      action: 'report.drafted',
      entityType: 'report',
      entityId: row!.id,
      organizationId: access.sr.organizationId,
      after: {
        serviceRequestId,
        kind: input.kind,
        title: input.title,
        templateId: template.id,
        templateVersion: template.version,
        referenceItems: input.referenceItems,
      },
      correlationId: options.correlationId,
    });
    const detail = await reportDetailFor(tx, row!, {
      organizationId: access.sr.organizationId,
      projectId: null,
      serviceRequestId,
      customer: false,
      customerContactUserId: access.sr.requestedByUserId,
    });
    return { ...detail, template };
  });
}

async function toReportDtos(tx: Transaction, rows: ReportRow[]): Promise<ReportDto[]> {
  const ids = [
    ...new Set(rows.flatMap((r) => [r.createdBy, r.namedReviewerUserId]).filter(Boolean)),
  ] as string[];
  const names =
    ids.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await tx
              .select({ id: schema.user.id, name: schema.user.name })
              .from(schema.user)
              .where(inArray(schema.user.id, ids))
          ).map((u) => [u.id, u.name]),
        );
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    projectId: r.projectId,
    serviceRequestId: r.serviceRequestId,
    siteVisitId: r.siteVisitId,
    kind: r.kind,
    title: r.title,
    status: r.status,
    currentVersion: r.currentVersion,
    releasedVersion: r.releasedVersion,
    releasedAt: iso(r.releasedAt),
    releasedBy: r.releasedBy,
    customerVisible: r.customerVisible,
    namedReviewerUserId: r.namedReviewerUserId,
    namedReviewerName: r.namedReviewerUserId ? (names.get(r.namedReviewerUserId) ?? null) : null,
    createdBy: r.createdBy,
    authorName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Staff and customer read checks for request reports (partners use their project workspace). */
const REQUEST_REPORT_READ_CHECKS: AccessCheck[] = [
  ...REQUEST_READ_CHECKS.filter((c) => c.staff),
  { staff: 'reports.draft' },
  { org: 'org.reports.view' },
];

/** Reports linked to a request (customers: released ones only). */
export async function listReportsForRequest(
  tx: Transaction,
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<ReportDto[]> {
  const access = await requireServiceRequest(
    tx,
    identity,
    serviceRequestId,
    REQUEST_REPORT_READ_CHECKS,
  );
  const customer = isRequestCustomer(identity, access);
  const rows = await tx
    .select()
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.serviceRequestId, serviceRequestId),
        customer ? eq(schema.reports.customerVisible, true) : undefined,
      ),
    )
    .orderBy(desc(schema.reports.createdAt), desc(schema.reports.id));
  return toReportDtos(tx, rows);
}

export async function listServiceRequestReports(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<{ items: ReportDto[] }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => ({
    items: await listReportsForRequest(tx, identity, serviceRequestId),
  }));
}

/* ---------------------------------------------------------------------- */
/* Export                                                                  */
/* ---------------------------------------------------------------------- */

export interface ReportExport {
  html: string;
  filename: string;
  version: number;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

/**
 * Print-ready HTML of the released version of a report (either scope).
 * Authorisation is exactly that of reading the released report; the export
 * is audited. Evidence appears as references (names and SHA-256 checksums),
 * never as signed download links.
 */
export async function exportReleasedReport(
  identity: RequestIdentity,
  reportId: string,
  options: ServiceOptions & { now?: Date } = {},
): Promise<ReportExport> {
  userIdOf(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { r, scope } = await loadReportScoped(tx, identity, reportId, REPORT_READ_CHECKS);
    if (scope.customer && !r.customerVisible) throw notFound('report');
    if (r.releasedVersion === null || r.releasedVersion === undefined) {
      if (scope.customer) throw notFound('report');
      throw invalidTransition('only a released report version can be exported');
    }
    const [rev] = await tx
      .select()
      .from(schema.reportRevisions)
      .where(
        and(
          eq(schema.reportRevisions.reportId, r.id),
          eq(schema.reportRevisions.version, r.releasedVersion),
        ),
      );
    if (!rev) throw notFound('released revision');
    const people = [r.createdBy, r.namedReviewerUserId, r.releasedBy, rev.reviewerUserId].filter(
      (v): v is string => Boolean(v),
    );
    const names = new Map(
      people.length === 0
        ? []
        : (
            await tx
              .select({ id: schema.user.id, name: schema.user.name })
              .from(schema.user)
              .where(inArray(schema.user.id, people))
          ).map((u) => [u.id, u.name] as const),
    );
    const [org] = await tx
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, r.organizationId));
    const [sr] = r.serviceRequestId
      ? await tx
          .select({
            reference: schema.serviceRequests.reference,
            title: schema.serviceRequests.title,
          })
          .from(schema.serviceRequests)
          .where(eq(schema.serviceRequests.id, r.serviceRequestId))
      : [];
    const [project] = r.projectId
      ? await tx
          .select({ name: schema.projects.name })
          .from(schema.projects)
          .where(eq(schema.projects.id, r.projectId))
      : [];
    // Evidence references: metadata only (name, checksum, size). The read is
    // elevated because the released report itself is what the caller may see;
    // files outside the report's organisation or request are never listed.
    const attachmentIds = rev.attachmentFileIds ?? [];
    const evidenceRefs: ExportEvidenceRef[] = await elevated(tx, ctx, async () => {
      const refs: ExportEvidenceRef[] = [];
      if (attachmentIds.length > 0) {
        const files = await tx
          .select()
          .from(schema.fileObjects)
          .where(inArray(schema.fileObjects.id, attachmentIds));
        for (const f of files) {
          const inScope =
            f.organizationId === r.organizationId ||
            (f.organizationId === null &&
              ((r.serviceRequestId &&
                f.entityType === 'service_request' &&
                f.entityId === r.serviceRequestId) ||
                (r.projectId && f.entityType === 'project' && f.entityId === r.projectId)));
          if (!inScope || f.deletedAt) continue;
          refs.push({
            source: 'Attachment',
            name: f.originalName,
            checksumSha256: f.checksumSha256 ?? null,
            sizeBytes: f.sizeBytes ?? null,
          });
        }
      }
      const linked = await tx
        .select({ e: schema.evidence, name: schema.fileObjects.originalName })
        .from(schema.evidence)
        .leftJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.evidence.fileId))
        .where(
          and(
            eq(schema.evidence.reportId, r.id),
            scope.customer
              ? or(
                  eq(schema.evidence.publication, 'approved'),
                  eq(schema.evidence.publication, 'redacted_public'),
                )
              : undefined,
          ),
        );
      for (const { e, name } of linked) {
        refs.push({
          source: `Evidence (${e.kind})`,
          name: name ?? e.caption ?? 'Evidence file',
          checksumSha256: e.checksumSha256 || null,
          sizeBytes: null,
          capturedAt: e.capturedAt ? e.capturedAt.toISOString() : null,
        });
      }
      return refs;
    });
    const findings = asEngagementFindings(rev.findings);
    const generatedAt = options.now ?? new Date();
    const html = renderReportExport({
      title: r.title,
      kind: r.kind,
      version: r.releasedVersion,
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
      organizationName: org?.name ?? null,
      context: sr ? `${sr.reference} · ${sr.title}` : project ? `Project: ${project.name}` : null,
      authorName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
      reviewerName: r.namedReviewerUserId ? (names.get(r.namedReviewerUserId) ?? null) : null,
      reviewedAt: rev.reviewedAt ? rev.reviewedAt.toISOString() : null,
      releasedByName: r.releasedBy ? (names.get(r.releasedBy) ?? null) : null,
      summary: rev.summary,
      bodyMarkdown: rev.bodyMarkdown,
      scopeLimitations: rev.scopeLimitations,
      items: findings.engagementItems?.items ?? [],
      itemsCapturedAt: findings.engagementItems?.capturedAt ?? null,
      evidence: evidenceRefs,
      generatedAt: generatedAt.toISOString(),
      reportId: r.id,
    });
    await recordAudit(tx, identity, {
      action: 'report.exported',
      entityType: 'report',
      entityId: r.id,
      organizationId: r.organizationId,
      after: { version: r.releasedVersion, format: 'html' },
      correlationId: options.correlationId,
    });
    return {
      html,
      version: r.releasedVersion,
      filename: `${slug(r.title)}-v${r.releasedVersion}.html`,
    };
  });
}
