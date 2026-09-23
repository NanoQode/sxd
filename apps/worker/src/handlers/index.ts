import type { JobRunner } from '../runner';
import { registerMaintenanceHandlers } from './maintenance';
import { registerNotificationHandlers } from './notifications';
import { registerPaymentHandlers } from './payments';
import { registerCalendarHandlers } from './calendar';
import { registerMediaHandlers } from './media';
import { registerMarketDataHandlers } from './market-data';
import { registerIntegrationHandlers } from './integrations';

export function registerHandlers(runner: JobRunner): void {
  registerMaintenanceHandlers(runner);
  registerNotificationHandlers(runner);
  registerPaymentHandlers(runner);
  registerCalendarHandlers(runner);
  registerMediaHandlers(runner);
  registerMarketDataHandlers(runner);
  registerIntegrationHandlers(runner);
}
