import { z } from 'zod';
import {
  deliveryLogItemSchema,
  deliveryRetryResponseSchema,
  devReceiptSimulateResponseSchema,
  devReceiptSimulateSchema,
  listRoutes,
  notificationChannelSchema,
  phoneVerificationConfirmResponseSchema,
  phoneVerificationConfirmSchema,
  phoneVerificationRequestResponseSchema,
  registerRoute,
  suppressionListQuerySchema,
  suppressionListResponseSchema,
  suppressionRemoveResponseSchema,
  suppressionRemoveSchema,
  templateFamilyDetailSchema,
  templateFamilySummarySchema,
  templateKeySchema,
  templateRestoreResponseSchema,
  templateRestoreSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registration for Admin → Communications (template families,
 * rollback, delivery detail/retry, suppressions, development receipts) and
 * the signed-in user's phone verification.
 */

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const idParams = z.object({ id: uuidSchema });

export const templateFamiliesRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/templates/families',
  summary: 'Template families (key × channel × locale) with the active version',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.families',
  auth: 'staff',
  request: {
    query: z.object({
      channel: notificationChannelSchema.optional(),
      search: z.string().max(64).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Families',
      body: z.object({ items: z.array(templateFamilySummarySchema) }),
    },
    403: { description: 'Needs notifications.templates.manage' },
  },
});

export const templateFamilyRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/templates/families/{key}/{channel}',
  summary: 'Template history, variable reference and SMS pricing',
  description:
    'Every version newest first (none is ever overwritten), the active version, variables with the sample values previews use, and for SMS the per-segment price from the active Termii settings.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.family',
  auth: 'staff',
  request: {
    params: z.object({ key: templateKeySchema, channel: notificationChannelSchema }),
    query: z.object({ locale: z.string().optional() }),
  },
  responses: {
    200: { description: 'Family', body: templateFamilyDetailSchema },
    404: { description: 'Unknown template' },
  },
});

export const templateRestoreRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/templates/{id}/restore',
  summary: 'Roll back by copying a version into a new version',
  description:
    'Creates the next version with the content of {id}. With `activate: true` it is approved in the same transaction and the previously active version is retired. Audited as template.rollback / template.restored.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.templates.restore',
  auth: 'staff',
  request: { params: idParams, body: templateRestoreSchema },
  responses: {
    201: { description: 'New version', body: templateRestoreResponseSchema },
    404: { description: 'Not found' },
  },
});

export const deliveryDetailRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/deliveries/{id}',
  summary: 'One delivery attempt with its status timeline',
  description:
    'Recipient masked. notifications.templates.manage sees every attempt; notifications.test_send alone sees test attempts only.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.deliveries.get',
  auth: 'staff',
  request: { params: idParams },
  responses: {
    200: { description: 'Attempt', body: deliveryLogItemSchema },
    404: { description: 'Not found' },
  },
});

export const deliveryRetryRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/deliveries/{id}/retry',
  summary: 'Retry a failed or rejected attempt (idempotent)',
  description:
    'Re-renders the original message for the same recipient and channel under the scope retry:{id}; current preferences, suppressions and verification rules apply. Repeating the request returns the existing retry with created=false and sends nothing. Verification codes and messages whose source event is not retained cannot be retried.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.deliveries.retry',
  auth: 'staff',
  idempotent: true,
  request: { params: idParams },
  responses: {
    201: { description: 'Retry sent', body: deliveryRetryResponseSchema },
    200: { description: 'Existing retry returned', body: deliveryRetryResponseSchema },
    409: { description: 'Not failed, or not retryable' },
  },
});

export const deliverySimulateReceiptRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/deliveries/{id}/simulate-receipt',
  summary: 'Development only: simulate an SMS delivery receipt',
  description:
    'Only for accepted SMS attempts handled by the labelled development adapter; the signed receipt goes through the real Termii webhook handler. 404 in production.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.deliveries.simulateReceipt',
  auth: 'staff',
  request: { params: idParams, body: devReceiptSimulateSchema },
  responses: {
    200: { description: 'Receipt processed', body: devReceiptSimulateResponseSchema },
    409: { description: 'Not a development SMS awaiting a receipt' },
  },
});

export const suppressionsListRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/notifications/suppressions',
  summary: 'Suppression list (STOP replies, hard bounces, complaints)',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.suppressions.list',
  auth: 'staff',
  request: { query: suppressionListQuerySchema },
  responses: { 200: { description: 'Page', body: suppressionListResponseSchema } },
});

export const suppressionRemoveRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/notifications/suppressions/{id}/remove',
  summary: 'Lift a suppression (reason required, audited)',
  description:
    'Consent recorded by a STOP reply is not changed, so transactional and marketing SMS stay blocked until the person opts in again.',
  tags: ['admin', 'notifications'],
  operationId: 'admin.notifications.suppressions.remove',
  auth: 'staff',
  request: { params: idParams, body: suppressionRemoveSchema },
  responses: {
    200: { description: 'Removed', body: suppressionRemoveResponseSchema },
    404: { description: 'Not found' },
  },
});

export const phoneVerificationRequestRoute = ensure({
  method: 'post',
  path: '/api/v1/me/phone/verification',
  summary: 'Send a verification code to the saved phone number',
  description:
    'Sends a 6-digit code (10 minutes, 5 attempts) through the configured SMS provider. Limits: one request per 60 s, 5 per user per hour, 5 per number per hour and 10 per number per day (429 with Retry-After). Only a hash of the code is stored. With the development adapter the response is labelled and, in development/test only, includes the code.',
  tags: ['Me'],
  operationId: 'requestPhoneVerification',
  auth: 'session',
  responses: {
    200: { description: 'Sent or already verified', body: phoneVerificationRequestResponseSchema },
    400: { description: 'No phone saved' },
    409: { description: 'Number opted out of SMS' },
    429: { description: 'Rate limited' },
    503: { description: 'SMS not configured or provider refused' },
  },
});

export const phoneVerificationConfirmRoute = ensure({
  method: 'post',
  path: '/api/v1/me/phone/verification/confirm',
  summary: 'Confirm the verification code',
  description:
    'Success marks the profile number verified (SMS notifications only go to verified numbers). Wrong codes count toward the attempt limit; expired or exhausted codes need a new request.',
  tags: ['Me'],
  operationId: 'confirmPhoneVerification',
  auth: 'session',
  request: { body: phoneVerificationConfirmSchema },
  responses: {
    200: { description: 'Verified', body: phoneVerificationConfirmResponseSchema },
    400: { description: 'Wrong, expired or exhausted code' },
    409: { description: 'Phone changed since the code was sent' },
  },
});
