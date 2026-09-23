import { z } from 'zod';
import {
  bounceImportSchema,
  deliveryAttemptListQuerySchema,
  deliveryAttemptListResponseSchema,
  listRoutes,
  notificationDtoSchema,
  notificationFeedQuerySchema,
  notificationFeedResponseSchema,
  providerStatusResponseSchema,
  readAllResponseSchema,
  registerRoute,
  templateActionSchema,
  templateCreateSchema,
  templateDtoSchema,
  templateListQuerySchema,
  templatePreviewResponseSchema,
  templatePreviewSchema,
  templateUpdateSchema,
  termiiWebhookAckSchema,
  testSendResponseSchema,
  testSendSchema,
  unreadCountResponseSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/** OpenAPI registration for the notification feed, admin tooling and the Termii webhook. */

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const idParams = z.object({ id: uuidSchema });

export const notificationsListRoute = ensure({
  method: 'get',
  path: '/api/v1/notifications',
  summary: 'In-app notification feed',
  description:
    'Newest first, cursor paged. Rows are scoped to the signed-in user by row-level security.',
  tags: ['notifications'],
  operationId: 'notifications.list',
  auth: 'session',
  request: { query: notificationFeedQuerySchema },
  responses: { 200: { description: 'Feed page', body: notificationFeedResponseSchema } },
});

export const notificationReadRoute = ensure({
  method: 'post',
  path: '/api/v1/notifications/{id}/read',
  summary: 'Mark a notification read',
  tags: ['notifications'],
  operationId: 'notifications.read',
  auth: 'session',
  request: { params: idParams },
  responses: {
    200: { description: 'Updated notification', body: notificationDtoSchema },
    404: { description: 'Not the caller’s notification' },
  },
});

export const notificationsReadAllRoute = ensure({
  method: 'post',
  path: '/api/v1/notifications/read-all',
  summary: 'Mark every notification read',
  tags: ['notifications'],
  operationId: 'notifications.readAll',
  auth: 'session',
  responses: { 200: { description: 'Count marked', body: readAllResponseSchema } },
});

export const notificationsUnreadCountRoute = ensure({
  method: 'get',
  path: '/api/v1/notifications/unread-count',
  summary: 'Unread badge count',
  tags: ['notifications'],
  operationId: 'notifications.unreadCount',
  auth: 'session',
  responses: { 200: { description: 'Count', body: unreadCountResponseSchema } },
});

export const adminTemplatesListRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/templates',
  summary: 'List notification template versions',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.list',
  auth: 'staff',
  request: { query: templateListQuerySchema },
  responses: {
    200: { description: 'Templates', body: z.object({ items: z.array(templateDtoSchema) }) },
  },
});

export const adminTemplatesCreateRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/templates',
  summary: 'Create a draft template version',
  description:
    'Requires notifications.templates.manage. Approved versions are immutable; edits create the next version.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.create',
  auth: 'staff',
  request: { body: templateCreateSchema },
  responses: {
    201: { description: 'Draft created', body: templateDtoSchema },
    400: { description: 'Validation failed' },
  },
});

export const adminTemplateGetRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/templates/{id}',
  summary: 'Get a template version',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.get',
  auth: 'staff',
  request: { params: idParams },
  responses: {
    200: { description: 'Template', body: templateDtoSchema },
    404: { description: 'Not found' },
  },
});

export const adminTemplateUpdateRoute = ensure({
  method: 'patch',
  path: '/api/v1/admin/notifications/templates/{id}',
  summary: 'Edit a draft template',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.update',
  auth: 'staff',
  request: { params: idParams, body: templateUpdateSchema },
  responses: {
    200: { description: 'Updated', body: templateDtoSchema },
    409: { description: 'Not a draft, or changed since loaded' },
  },
});

export const adminTemplateActionRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/templates/{id}/actions',
  summary: 'Approve, retire or reopen a template version',
  description:
    'Approving retires older approved versions of the same key/channel/locale so exactly one version sends.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.action',
  auth: 'staff',
  request: { params: idParams, body: templateActionSchema },
  responses: {
    200: { description: 'Updated', body: templateDtoSchema },
    409: { description: 'Invalid transition' },
  },
});

export const adminTemplatePreviewRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/templates/preview',
  summary: 'Preview a template with sample variables',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.preview',
  auth: 'staff',
  request: { body: templatePreviewSchema },
  responses: { 200: { description: 'Rendered preview', body: templatePreviewResponseSchema } },
});

export const adminTestSendRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/test-send',
  summary: 'Send an explicit test email or SMS',
  description:
    'Requires notifications.test_send (no MFA step). Sends through the active provider to the staff-entered recipient, records a delivery attempt labelled test and returns the real provider result. Rate limited to 30 per hour per user.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.testSend',
  auth: 'staff',
  request: { body: testSendSchema },
  responses: {
    200: { description: 'Provider result', body: testSendResponseSchema },
    429: { description: 'Rate limited' },
  },
});

export const adminDeliveriesRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/deliveries',
  summary: 'Delivery log',
  description:
    'Every delivery attempt with provider ids, real status (accepted is not delivered) and sanitised errors.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.deliveries.list',
  auth: 'staff',
  request: { query: deliveryAttemptListQuerySchema },
  responses: { 200: { description: 'Page', body: deliveryAttemptListResponseSchema } },
});

export const adminProvidersRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/providers',
  summary: 'Notification provider status',
  description:
    'SMTP and Termii state for the current environment (configured / unverified / connected) without secrets or settings.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.providers',
  auth: 'staff',
  responses: { 200: { description: 'Providers', body: providerStatusResponseSchema } },
});

export const adminBounceImportRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/bounces',
  summary: 'Import an email bounce or complaint',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.bounces.import',
  auth: 'staff',
  request: { body: bounceImportSchema },
  responses: {
    200: {
      description: 'Result',
      body: z.object({ attemptId: uuidSchema.nullable(), suppressed: z.boolean() }),
    },
  },
});

export const termiiWebhookRoute = ensure({
  method: 'post',
  path: '/api/v1/webhooks/termii',
  summary: 'Termii delivery receipts and inbound replies',
  description:
    'Verifies X-Termii-Signature when a webhook secret is configured; unsigned events are accepted only outside production. Updates delivery state and handles STOP/START keywords.',
  tags: ['webhooks'],
  operationId: 'webhooks.termii',
  auth: 'webhook',
  responses: {
    200: { description: 'Processed', body: termiiWebhookAckSchema },
    401: { description: 'Invalid signature' },
    403: { description: 'Unsigned event refused in production' },
  },
});
