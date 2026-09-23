import 'server-only';
import { eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeOrg, type OrgPermission } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  REQUEST_MANAGE_CHECKS,
  allowsRequest,
  isRequestCustomer,
  requireServiceRequest,
  type ServiceRequestAccess,
} from '@/server/engagements/access';
import type { AccessCheck } from '@/server/projects/access';

/**
 * Access for the property-search and purchase-representation workspaces of a
 * service request. The shortlist, viewings, offers and closing records are
 * visible to the customer organisation and to staff who read the request
 * (project managers only when attached to it); partners never see them.
 * Staff manage them with the request's manage permissions
 * (`service_requests.triage` / `projects.manage`); the customer acts with
 * the organisation permission named at each call site.
 */

export type WorkspaceViewer = 'customer' | 'staff';

/** Customer organisation members (read) and staff who read requests. */
export const WORKSPACE_READ_CHECKS: AccessCheck[] = [
  { staff: 'service_requests.read_all' },
  { org: 'org.read' },
];

export interface WorkspaceAccess {
  access: ServiceRequestAccess;
  viewer: WorkspaceViewer;
  /** The request's service workflow template (property_search, purchase_support ...). */
  workflowTemplateKey: string;
  serviceName: string;
}

export const forbidden = (message: string) => new ApiError('forbidden', message);

/** Loads the request under the caller's row-level security and classifies the viewer. */
export async function requireWorkspace(
  tx: Transaction,
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<WorkspaceAccess> {
  const access = await requireServiceRequest(
    tx,
    identity,
    serviceRequestId,
    WORKSPACE_READ_CHECKS,
  );
  const viewer: WorkspaceViewer | null =
    identity.actor.staffRoles.length > 0
      ? 'staff'
      : isRequestCustomer(identity, access)
        ? 'customer'
        : null;
  if (!viewer) throw forbidden('partners do not see the search and purchase records');
  const [service] = await tx
    .select({ key: schema.services.workflowTemplateKey, name: schema.services.name })
    .from(schema.services)
    .where(eq(schema.services.id, access.sr.serviceId));
  return {
    access,
    viewer,
    workflowTemplateKey: service?.key ?? 'unknown',
    serviceName: service?.name ?? 'Service',
  };
}

/** Staff managing this request (project managers must be attached to it). */
export function requireStaffManage(identity: RequestIdentity, ws: WorkspaceAccess): void {
  if (ws.viewer !== 'staff' || !allowsRequest(identity, ws.access, REQUEST_MANAGE_CHECKS)) {
    throw forbidden('only staff managing this request may do this');
  }
}

/** A customer organisation member holding `permission` for this request's organisation. */
export function requireCustomer(
  identity: RequestIdentity,
  ws: WorkspaceAccess,
  permission: OrgPermission,
): void {
  if (ws.viewer !== 'customer') throw forbidden('this action belongs to the customer');
  assertAllowed(
    authorizeOrg(identity.actor, permission, {
      type: 'service_request',
      id: ws.access.sr.id,
      organizationId: ws.access.sr.organizationId,
    }),
  );
}

/** Either the customer (with `permission`) or staff managing the request. */
export function requireCustomerOrStaff(
  identity: RequestIdentity,
  ws: WorkspaceAccess,
  permission: OrgPermission,
): WorkspaceViewer {
  if (ws.viewer === 'staff') {
    requireStaffManage(identity, ws);
    return 'staff';
  }
  requireCustomer(identity, ws, permission);
  return 'customer';
}

const CLOSED = ['completed', 'cancelled', 'rejected'];

export function assertRequestOpen(ws: WorkspaceAccess): void {
  if (CLOSED.includes(ws.access.sr.status)) {
    throw new ApiError(
      'invalid_transition',
      `the request is ${ws.access.sr.status}; its records are read-only`,
    );
  }
}

/** The workspace is meaningful for these services only (others get an honest 404). */
export function assertWorkflow(ws: WorkspaceAccess, keys: string[]): void {
  if (!keys.includes(ws.workflowTemplateKey)) {
    throw new ApiError('not_found', `this request's service has no ${keys.join('/')} workspace`);
  }
}
