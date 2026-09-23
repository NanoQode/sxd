import type { Readable } from 'node:stream';

/**
 * Malware scanning contract.
 *
 * Verdict semantics (enforced by the upload pipeline, documented here):
 * - `clean`    → the object may be promoted from quarantine to the private bucket.
 * - `infected` → the object stays in quarantine, the file record becomes `infected`
 *                and is never downloadable; the uploader is told the file was rejected.
 * - `error`    → the scanner could not decide (timeout, connection failure, size
 *                limit, protocol error). The object MUST remain in quarantine and the
 *                file record becomes `scan_failed`; a retry job may rescan later.
 *                A failed scanner never results in a downloadable file.
 */

export type ScanVerdict = 'clean' | 'infected' | 'error';

export interface ScanInput {
  fileName: string;
  sizeBytes: number;
}

export interface ScanResult {
  verdict: ScanVerdict;
  /** Signature name when infected (e.g. `Eicar-Signature`). */
  signature: string | null;
  engine: string;
  durationMs: number;
  /** Sanitised reason when verdict is `error`. */
  error?: string;
}

export interface ScannerPing {
  ok: boolean;
  version: string | null;
}

export interface MalwareScanner {
  readonly id: 'clamav' | 'dev';
  scan(source: Buffer | Uint8Array | Readable, input: ScanInput): Promise<ScanResult>;
  ping(): Promise<ScannerPing>;
}
