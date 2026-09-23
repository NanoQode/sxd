import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import { toFileDto } from '@/server/files/shared';
import type { FileDto } from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Organisation document library: every non-deleted file of the active
 * organisation grouped by the entity it is attached to. Row-level security
 * and the organisation filter keep the listing to the caller's own records;
 * downloads are re-authorised per file by the download endpoint.
 */

export type LibraryFolderKey =
  | 'service_request'
  | 'project'
  | 'property'
  | 'invoice'
  | 'site_visit'
  | 'content_page'
  | 'unattached';

export interface LibraryEntry {
  file: FileDto;
  /** Human label of the parent record (reference, project name, property name, invoice number). */
  entityLabel: string | null;
  entityHref: string | null;
}

export interface LibraryFolder {
  key: LibraryFolderKey;
  label: string;
  description: string;
  items: LibraryEntry[];
}

const FOLDERS: Array<{ key: LibraryFolderKey; label: string; description: string }> = [
  {
    key: 'unattached',
    label: 'Organisation documents',
    description: 'Contracts, letters and surveys kept on your account.',
  },
  { key: 'service_request', label: 'Requests', description: 'Files shared on service requests.' },
  {
    key: 'project',
    label: 'Projects',
    description: 'Drawings, evidence and deliverables on projects.',
  },
  {
    key: 'property',
    label: 'Properties',
    description: 'Title documents, owner authorities and surveys.',
  },
  { key: 'invoice', label: 'Invoices', description: 'Bank transfer proofs and payment documents.' },
  { key: 'site_visit', label: 'Site visits', description: 'Evidence captured during inspections.' },
  { key: 'content_page', label: 'Other', description: 'Files attached to other records.' },
];

export async function loadDocumentLibrary(identity: RequestIdentity): Promise<LibraryFolder[]> {
  const orgId = identity.ctx.organizationId;
  if (!orgId || !identity.session) return [];
  return withActor(getDb(), identity.ctx, async (tx) => {
    const files = await tx
      .select()
      .from(schema.fileObjects)
      .where(
        and(
          eq(schema.fileObjects.organizationId, orgId),
          isNull(schema.fileObjects.deletedAt),
          sql`${schema.fileObjects.status} <> 'pending_upload'`,
          sql`${schema.fileObjects.purpose} <> 'identity'`,
        ),
      )
      .orderBy(desc(schema.fileObjects.createdAt))
      .limit(500);

    const idsBy = (type: string) => [
      ...new Set(files.filter((f) => f.entityType === type && f.entityId).map((f) => f.entityId!)),
    ];
    const labels = new Map<string, { label: string; href: string }>();
    const requestIds = idsBy('service_request');
    if (requestIds.length > 0) {
      const rows = await tx
        .select({
          id: schema.serviceRequests.id,
          reference: schema.serviceRequests.reference,
          title: schema.serviceRequests.title,
        })
        .from(schema.serviceRequests)
        .where(inArray(schema.serviceRequests.id, requestIds));
      for (const r of rows)
        labels.set(r.id, {
          label: `${r.reference} · ${r.title}`,
          href: `/portal/requests/${r.id}?tab=documents`,
        });
    }
    const projectIds = idsBy('project');
    if (projectIds.length > 0) {
      const rows = await tx
        .select({ id: schema.projects.id, name: schema.projects.name })
        .from(schema.projects)
        .where(inArray(schema.projects.id, projectIds));
      for (const r of rows)
        labels.set(r.id, { label: r.name, href: `/portal/projects/${r.id}?tab=media` });
    }
    const propertyIds = idsBy('property');
    if (propertyIds.length > 0) {
      const rows = await tx
        .select({ id: schema.properties.id, name: schema.properties.name })
        .from(schema.properties)
        .where(inArray(schema.properties.id, propertyIds));
      for (const r of rows)
        labels.set(r.id, { label: r.name, href: `/portal/properties/${r.id}?tab=documents` });
    }
    const invoiceIds = idsBy('invoice');
    if (invoiceIds.length > 0) {
      const rows = await tx
        .select({ id: schema.invoices.id, number: schema.invoices.number })
        .from(schema.invoices)
        .where(inArray(schema.invoices.id, invoiceIds));
      for (const r of rows)
        labels.set(r.id, { label: `Invoice ${r.number}`, href: `/portal/invoices/${r.id}` });
    }

    const grouped = new Map<LibraryFolderKey, LibraryEntry[]>();
    for (const f of files) {
      const key: LibraryFolderKey =
        f.entityType && f.entityId && FOLDERS.some((x) => x.key === f.entityType)
          ? (f.entityType as LibraryFolderKey)
          : 'unattached';
      const meta = f.entityId ? labels.get(f.entityId) : undefined;
      const list = grouped.get(key) ?? [];
      list.push({
        file: toFileDto(f),
        entityLabel: meta?.label ?? null,
        entityHref: meta?.href ?? null,
      });
      grouped.set(key, list);
    }
    return FOLDERS.map((folder) => ({ ...folder, items: grouped.get(folder.key) ?? [] }));
  });
}
