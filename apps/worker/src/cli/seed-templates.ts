import { createMigrationDb } from '@simplexd/db';
import { ensureNotificationTemplates } from '@simplexd/notifications';

/**
 * Loads the notification templates the delivery pipeline depends on
 * (reference templates plus the event-specific extras). Idempotent; existing
 * templates are never overwritten so administrator edits survive re-runs.
 */
const { db, pool } = createMigrationDb();
try {
  const inserted = await ensureNotificationTemplates(db);
  process.stdout.write(`Notification templates ensured (${inserted} inserted).\n`);
} finally {
  await pool.end();
}
