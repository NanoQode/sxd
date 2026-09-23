import { ClamAvScanner, type ClamAvOptions } from './clamav';
import { DevMalwareScanner } from './dev';
import type { MalwareScanner } from './types';

export interface ScannerFactoryInput {
  appEnv: string;
  scanner: 'clamav' | 'dev';
  clamav?: ClamAvOptions;
}

export function createMalwareScanner(input: ScannerFactoryInput): MalwareScanner {
  if (input.scanner === 'clamav') {
    if (!input.clamav)
      throw new Error('CLAMAV_HOST and CLAMAV_PORT are required for MALWARE_SCANNER=clamav');
    return new ClamAvScanner(input.clamav);
  }
  return new DevMalwareScanner({ appEnv: input.appEnv });
}

export function scannerConfigFromEnv(env: Record<string, string | undefined>): ScannerFactoryInput {
  const scanner = env.MALWARE_SCANNER === 'clamav' ? 'clamav' : 'dev';
  return {
    appEnv: env.APP_ENV ?? 'development',
    scanner,
    clamav:
      scanner === 'clamav'
        ? {
            host: env.CLAMAV_HOST ?? '127.0.0.1',
            port: Number(env.CLAMAV_PORT ?? 3310),
            timeoutMs: env.CLAMAV_TIMEOUT_MS ? Number(env.CLAMAV_TIMEOUT_MS) : undefined,
            maxBytes: env.CLAMAV_MAX_BYTES ? Number(env.CLAMAV_MAX_BYTES) : undefined,
          }
        : undefined,
  };
}
