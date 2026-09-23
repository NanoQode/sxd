import { Readable } from 'node:stream';
import type { MalwareScanner, ScanInput, ScanResult, ScannerPing } from './types';

/**
 * DEVELOPMENT SCANNER — labelled, refused outside APP_ENV=development|test.
 * Flags the EICAR test string as infected and everything else as clean, so the
 * quarantine → private promotion path and the rejection path can both be
 * exercised locally. A file whose name contains `.scan-error.` yields an
 * `error` verdict to exercise the "failed scanner keeps the object quarantined"
 * path (acceptance scenario 12).
 *
 * The EICAR string is assembled at runtime so this source file itself is not
 * quarantined by antivirus software on developer machines or CI runners.
 */

export const EICAR_TEST_STRING = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');
export const DEV_SCANNER_ENGINE = 'dev-eicar';
const SNIFF_BYTES = 64 * 1024;

export interface DevScannerOptions {
  appEnv: string;
  /** Artificial latency to make the "scanning" state visible in the UI. */
  delayMs?: number;
}

export class DevMalwareScanner implements MalwareScanner {
  readonly id = 'dev' as const;
  private readonly delayMs: number;

  constructor(options: DevScannerOptions) {
    if (options.appEnv !== 'development' && options.appEnv !== 'test') {
      throw new Error(
        `DevMalwareScanner is a development adapter and cannot be used when APP_ENV=${options.appEnv}; configure MALWARE_SCANNER=clamav`,
      );
    }
    this.delayMs = options.delayMs ?? 0;
  }

  async ping(): Promise<ScannerPing> {
    return { ok: true, version: 'dev-eicar/1 (development only)' };
  }

  async scan(source: Buffer | Uint8Array | Readable, input: ScanInput): Promise<ScanResult> {
    const started = Date.now();
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const done = (partial: Omit<ScanResult, 'engine' | 'durationMs'>): ScanResult => ({
      ...partial,
      engine: DEV_SCANNER_ENGINE,
      durationMs: Date.now() - started,
    });
    if (/\.scan-error\./i.test(input.fileName)) {
      return done({ verdict: 'error', signature: null, error: 'simulated scanner failure (dev)' });
    }
    let head: Buffer;
    if (source instanceof Readable) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        if (size < SNIFF_BYTES) chunks.push(buf.subarray(0, SNIFF_BYTES - size));
        size += buf.length;
      }
      head = Buffer.concat(chunks);
    } else {
      head = Buffer.from(source.subarray(0, SNIFF_BYTES));
    }
    if (head.toString('latin1').includes(EICAR_TEST_STRING)) {
      return done({ verdict: 'infected', signature: 'Eicar-Signature' });
    }
    return done({ verdict: 'clean', signature: null });
  }
}
