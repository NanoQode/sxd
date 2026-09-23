import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, jsonObject, kobo, timestamps, tstz, version } from './_common';
import { organization, user } from './auth';

/** tstzrange for slot reservations; written via explicit SQL. */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

export const appointmentKindEnum = pgEnum('appointment_kind', [
  'consultation',
  'viewing',
  'site_visit',
  'virtual_inspection',
  'meeting',
  'test_booking',
]);

export const appointmentStatusEnum = pgEnum('appointment_status', [
  'pending_confirmation',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show',
]);

export const meetingProviderEnum = pgEnum('meeting_provider', [
  'none',
  'google_meet',
  'external',
  'in_person',
]);

export const calendarSyncStatusEnum = pgEnum('calendar_sync_status', [
  'not_requested',
  'pending',
  'synced',
  'failed',
  'cancelled',
  'conflict',
]);

export const conferenceStatusEnum = pgEnum('conference_status', [
  'none',
  'pending',
  'ready',
  'failed',
]);

export const reservationKindEnum = pgEnum('reservation_kind', [
  'hold',
  'appointment',
  'leave',
  'buffer',
  'block',
]);

export const calendarConnectionStatusEnum = pgEnum('calendar_connection_status', [
  'disconnected',
  'configured_unverified',
  'connected',
  'degraded',
  'expired',
  'disabled',
]);

export const eventSyncStatusEnum = pgEnum('event_sync_status', [
  'pending',
  'created',
  'updated',
  'cancelled',
  'failed',
  'conflict',
]);

export const conversationKindEnum = pgEnum('conversation_kind', [
  'customer_team',
  'tenant_support',
  'partner',
  'internal',
  'support_ticket',
]);

export const notificationChannelEnum = pgEnum('notification_channel', ['email', 'sms', 'in_app']);

export const notificationCategoryEnum = pgEnum('notification_category', [
  'security',
  'transactional',
  'reminders',
  'digests',
  'marketing',
]);

export const digestFrequencyEnum = pgEnum('digest_frequency', ['none', 'daily', 'weekly']);

export const templateStatusEnum = pgEnum('template_status', ['draft', 'approved', 'retired']);

export const messageDeliveryStatusEnum = pgEnum('message_delivery_status', [
  'queued',
  'accepted',
  'sent',
  'delivered',
  'failed',
  'suppressed',
  'bounced',
  'rejected',
]);

export const consentStatusEnum = pgEnum('consent_status', ['opted_in', 'opted_out']);

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    kind: appointmentKindEnum().notNull(),
    status: appointmentStatusEnum().notNull().default('pending_confirmation'),
    staffUserId: text()
      .notNull()
      .references(() => user.id),
    customerUserId: text().references(() => user.id),
    guestName: text(),
    guestEmail: text(),
    guestPhoneE164: text(),
    startsAt: tstz().notNull(),
    endsAt: tstz().notNull(),
    customerTimeZone: text().notNull().default('Africa/Lagos'),
    businessTimeZone: text().notNull().default('Africa/Lagos'),
    topic: text(),
    notes: text(),
    locationNote: text(),
    meetingProvider: meetingProviderEnum().notNull().default('none'),
    /** Private; exposed only to authorised participants. */
    meetingUrl: text(),
    calendarSyncStatus: calendarSyncStatusEnum().notNull().default('not_requested'),
    conferenceStatus: conferenceStatusEnum().notNull().default('none'),
    cancellationReason: text(),
    cancelledBy: text().references(() => user.id),
    cancelledAt: tstz(),
    rescheduledFromId: uuid(),
    leadId: uuid(),
    serviceRequestId: uuid(),
    siteVisitId: uuid(),
    icsToken: text().notNull().unique(),
    manageToken: text().unique(),
    remindersSent: jsonObject<string[]>(),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    index('appointments_staff_idx').on(t.staffUserId, t.startsAt),
    index('appointments_customer_idx').on(t.customerUserId),
    index('appointments_org_idx').on(t.organizationId),
  ],
);

/**
 * Exclusive slot reservations per staff member. An EXCLUDE constraint on
 * (staff_user_id, slot) is added in the RLS/constraints migration so two
 * concurrent requests can never reserve overlapping time.
 */
export const slotReservations = pgTable(
  'slot_reservations',
  {
    id: id(),
    staffUserId: text()
      .notNull()
      .references(() => user.id),
    slot: tstzrange().notNull(),
    kind: reservationKindEnum().notNull(),
    expiresAt: tstz(),
    holdToken: text().unique(),
    appointmentId: uuid().references(() => appointments.id),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index('slot_reservations_staff_idx').on(t.staffUserId)],
);

export const staffAvailability = pgTable(
  'staff_availability',
  {
    id: id(),
    staffUserId: text()
      .notNull()
      .references(() => user.id),
    weekday: integer().notNull(),
    startTime: time().notNull(),
    endTime: time().notNull(),
    timeZone: text().notNull().default('Africa/Lagos'),
    kinds: jsonObject<string[]>(),
    active: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('staff_availability_staff_idx').on(t.staffUserId, t.weekday)],
);

export const bookingSettings = pgTable('booking_settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedBy: text().references(() => user.id),
  ...timestamps(),
});

export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: id(),
    provider: text().notNull().default('google'),
    environment: text().notNull().default('live'),
    organizerUserId: text()
      .notNull()
      .references(() => user.id),
    accountEmail: text(),
    calendarId: text(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: calendarConnectionStatusEnum().notNull().default('disconnected'),
    refreshTokenSecretId: uuid(),
    accessTokenSecretId: uuid(),
    accessTokenExpiresAt: tstz(),
    lastCheckedAt: tstz(),
    lastCheckOk: boolean(),
    lastErrorSanitized: text(),
    connectedAt: tstz(),
    disconnectedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendar_connections_unique').on(t.provider, t.environment, t.organizerUserId),
  ],
);

export const eventSyncs = pgTable(
  'event_syncs',
  {
    id: id(),
    appointmentId: uuid()
      .notNull()
      .unique()
      .references(() => appointments.id),
    calendarConnectionId: uuid().references(() => calendarConnections.id),
    providerEventId: text(),
    providerCalendarId: text(),
    conferenceRequestId: text().notNull(),
    etag: text(),
    sequence: integer(),
    syncVersion: integer().notNull().default(0),
    status: eventSyncStatusEnum().notNull().default('pending'),
    conferenceStatus: conferenceStatusEnum().notNull().default('pending'),
    meetUrl: text(),
    lastSyncedAt: tstz(),
    lastErrorSanitized: text(),
    attempts: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('event_syncs_provider_event_idx').on(t.providerEventId)],
);

export const calendarWatchChannels = pgTable(
  'calendar_watch_channels',
  {
    id: id(),
    calendarConnectionId: uuid()
      .notNull()
      .references(() => calendarConnections.id),
    channelId: text().notNull().unique(),
    resourceId: text(),
    tokenHash: text().notNull(),
    expiration: tstz(),
    syncToken: text(),
    status: text().notNull().default('active'),
    lastNotificationAt: tstz(),
    ...timestamps(),
  },
  (t) => [index('calendar_watch_channels_conn_idx').on(t.calendarConnectionId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    kind: conversationKindEnum().notNull(),
    subject: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    createdBy: text().references(() => user.id),
    lastMessageAt: tstz(),
    closedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('conversations_org_idx').on(t.organizationId),
    index('conversations_entity_idx').on(t.entityType, t.entityId),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id),
    role: text().notNull().default('participant'),
    joinedAt: createdAt(),
    lastReadAt: tstz(),
    leftAt: tstz(),
  },
  (t) => [
    uniqueIndex('conversation_participants_unique').on(t.conversationId, t.userId),
    index('conversation_participants_user_idx').on(t.userId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id),
    senderUserId: text().references(() => user.id),
    body: text().notNull(),
    attachmentFileIds: jsonObject<string[]>(),
    internalOnly: boolean().notNull().default(false),
    createdAt: createdAt(),
    editedAt: tstz(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text().references(() => organization.id),
    category: notificationCategoryEnum().notNull().default('transactional'),
    kind: text().notNull(),
    title: text().notNull(),
    body: text(),
    linkPath: text(),
    entityType: text(),
    entityId: uuid(),
    dedupeKey: text().unique(),
    readAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: id(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum().notNull(),
    category: notificationCategoryEnum().notNull(),
    enabled: boolean().notNull().default(true),
    digest: digestFrequencyEnum().notNull().default('none'),
    quietHoursStart: time(),
    quietHoursEnd: time(),
    timeZone: text(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('notification_preferences_unique').on(t.userId, t.channel, t.category)],
);

export const templates = pgTable(
  'templates',
  {
    id: id(),
    key: text().notNull(),
    channel: notificationChannelEnum().notNull(),
    locale: text().notNull().default('en'),
    version: integer().notNull().default(1),
    subject: text(),
    bodyText: text().notNull(),
    bodyHtml: text(),
    variables: jsonObject<string[]>(),
    status: templateStatusEnum().notNull().default('draft'),
    approvedBy: text().references(() => user.id),
    approvedAt: tstz(),
    createdBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex('templates_unique').on(t.key, t.channel, t.locale, t.version)],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: id(),
    channel: notificationChannelEnum().notNull(),
    category: notificationCategoryEnum().notNull().default('transactional'),
    templateKey: text(),
    templateVersion: integer(),
    recipient: text().notNull(),
    userId: text().references(() => user.id),
    provider: text().notNull(),
    environment: text().notNull().default('test'),
    status: messageDeliveryStatusEnum().notNull().default('queued'),
    providerMessageId: text(),
    providerStatus: text(),
    errorSanitized: text(),
    segments: integer(),
    estimatedCostKobo: kobo(),
    dedupeKey: text().unique(),
    relatedEntityType: text(),
    relatedEntityId: uuid(),
    subject: text(),
    queuedAt: createdAt(),
    sentAt: tstz(),
    deliveredAt: tstz(),
    failedAt: tstz(),
    attempts: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('delivery_attempts_status_idx').on(t.status, t.queuedAt),
    index('delivery_attempts_provider_msg_idx').on(t.provider, t.providerMessageId),
    index('delivery_attempts_user_idx').on(t.userId),
  ],
);

export const smsConsents = pgTable(
  'sms_consents',
  {
    id: id(),
    phoneE164: text().notNull(),
    userId: text().references(() => user.id),
    category: notificationCategoryEnum().notNull(),
    status: consentStatusEnum().notNull(),
    source: text().notNull(),
    recordedAt: createdAt(),
  },
  (t) => [index('sms_consents_phone_idx').on(t.phoneE164, t.category, t.recordedAt)],
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    channel: notificationChannelEnum().notNull(),
    address: text().notNull(),
    reason: text().notNull(),
    source: text(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppressions_unique').on(t.channel, t.address)],
);

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    purpose: text().notNull(),
    subject: text().notNull(),
    codeHash: text().notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    expiresAt: tstz().notNull(),
    consumedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [index('otp_challenges_subject_idx').on(t.purpose, t.subject)],
);
