import type { JobRunner } from '../runner';

export function registerIntegrationHandlers(runner: JobRunner): void {
  runner.register('integrations.run_test', async ({ log }) => {
    log.info('integration test placeholder (implemented in Wave 3)');
  });
}
