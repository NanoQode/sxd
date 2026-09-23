import type { JobRunner } from '../runner';

export function registerMediaHandlers(runner: JobRunner): void {
  runner.register('media.scan_and_process', async ({ log }) => {
    log.info('media scan/process placeholder (implemented in Wave 2)');
  });
}
