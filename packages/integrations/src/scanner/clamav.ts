import { once } from 'node:events';
import net from 'node:net';
import { Readable } from 'node:stream';
import type { MalwareScanner, ScanInput, ScanResult, ScannerPing } from './types';

/**
 * clamd client using the INSTREAM command over TCP.
 *
 * Protocol (clamd(8)): commands are sent as `z<COMMAND>\0` (NUL-terminated, so
 * responses are NUL-terminated too). INSTREAM then expects chunks of
 * `<4-byte big-endian length><data>` and a zero-length chunk to finish.
 * clamd answers `stream: OK`, `stream: <Signature> FOUND` or
 * `INSTREAM size limit exceeded. ERROR` (when StreamMaxLength is exceeded).
 *
 * Every failure path returns an `error` verdict rather than throwing so the
 * object stays quarantined and the job can be retried.
 */

export interface ClamAvOptions {
  host: string;
  port: number;
  /** Whole-scan budget (default 60 s). */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Refuse to stream more than this (default 100 MiB, clamd's StreamMaxLength default). */
  maxBytes?: number;
  chunkBytes?: number;
}

export const CLAMAV_ENGINE = 'clamav';
export const INSTREAM_TERMINATOR = Buffer.alloc(4, 0);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** `<4-byte big-endian length><data>` */
export function frameChunk(chunk: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(chunk.length, 0);
  return Buffer.concat([header, chunk]);
}

export type ParsedClamResponse =
  | { verdict: 'clean'; signature: null }
  | { verdict: 'infected'; signature: string }
  | { verdict: 'error'; signature: null; error: string };

/** Parses one clamd response line (NUL/newline stripped). */
export function parseClamResponse(raw: string): ParsedClamResponse {
  const line = raw.replace(/\0+$/, '').trim();
  if (/^(stream|-):?\s*OK$/.test(line) || line === 'stream: OK')
    return { verdict: 'clean', signature: null };
  const found = /^(?:stream|-):\s*(.+?)\s+FOUND$/.exec(line);
  if (found && found[1]) return { verdict: 'infected', signature: found[1] };
  if (/ERROR$/.test(line)) return { verdict: 'error', signature: null, error: line };
  return {
    verdict: 'error',
    signature: null,
    error: `unexpected clamd response: ${line.slice(0, 120)}`,
  };
}

function toChunks(
  source: Buffer | Uint8Array | Readable,
  chunkBytes: number,
): AsyncIterable<Buffer> {
  if (source instanceof Readable) {
    return (async function* () {
      for await (const chunk of source) {
        const buf =
          typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        for (let offset = 0; offset < buf.length; offset += chunkBytes)
          yield buf.subarray(offset, offset + chunkBytes);
      }
    })();
  }
  const buf = Buffer.from(source);
  return (async function* () {
    for (let offset = 0; offset < buf.length; offset += chunkBytes)
      yield buf.subarray(offset, offset + chunkBytes);
  })();
}

export class ClamAvScanner implements MalwareScanner {
  readonly id = 'clamav' as const;
  private readonly options: Required<ClamAvOptions>;

  constructor(options: ClamAvOptions) {
    if (!options.host) throw new Error('CLAMAV_HOST is required');
    if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535)
      throw new Error('CLAMAV_PORT must be a valid TCP port');
    this.options = {
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    };
  }

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`clamd connect timeout after ${this.options.connectTimeoutMs} ms`));
      }, this.options.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Sends a single z-command and returns the NUL-terminated response. */
  private async command(cmd: string, timeoutMs: number): Promise<string> {
    const socket = await this.connect();
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`clamd ${cmd} timeout`));
      }, timeoutMs);
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\0');
        if (end !== -1) finish(() => resolve(buffer.slice(0, end)));
      });
      socket.on('error', (err) => finish(() => reject(err)));
      socket.on('close', () => {
        if (buffer.length > 0) finish(() => resolve(buffer.replace(/\0+$/, '')));
        else finish(() => reject(new Error('clamd closed the connection without a response')));
      });
      socket.write(`z${cmd}\0`);
    });
  }

  async ping(): Promise<ScannerPing> {
    try {
      const pong = await this.command('PING', this.options.connectTimeoutMs);
      if (pong.trim() !== 'PONG') return { ok: false, version: null };
      const version = await this.command('VERSION', this.options.connectTimeoutMs);
      return { ok: true, version: version.trim() || null };
    } catch {
      return { ok: false, version: null };
    }
  }

  private async instream(source: Buffer | Uint8Array | Readable): Promise<string> {
    const socket = await this.connect();
    let response = '';
    let settled = false;
    let resolveResponse: (value: string) => void = () => {};
    let rejectResponse: (reason: Error) => void = () => {};
    const responsePromise = new Promise<string>((resolve, reject) => {
      resolveResponse = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      rejectResponse = (reason) => {
        if (!settled) {
          settled = true;
          reject(reason);
        }
      };
    });
    const timer = setTimeout(() => {
      rejectResponse(new Error(`clamd scan timeout after ${this.options.timeoutMs} ms`));
      socket.destroy();
    }, this.options.timeoutMs);

    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      const end = response.indexOf('\0');
      if (end !== -1) {
        resolveResponse(response.slice(0, end));
        socket.end();
      }
    });
    socket.on('error', (err) => rejectResponse(err));
    socket.on('close', () => {
      if (response.length > 0) resolveResponse(response.replace(/\0+$/, ''));
      else rejectResponse(new Error('clamd closed the connection before returning a verdict'));
    });

    const write = async (data: Buffer): Promise<void> => {
      if (socket.destroyed || settled) return;
      if (!socket.write(data))
        await Promise.race([once(socket, 'drain'), responsePromise.catch(() => undefined)]);
    };

    try {
      await write(Buffer.from('zINSTREAM\0'));
      let sent = 0;
      for await (const chunk of toChunks(source, this.options.chunkBytes)) {
        if (settled) break;
        sent += chunk.length;
        if (sent > this.options.maxBytes) {
          rejectResponse(
            new Error(`file exceeds the scanner limit of ${this.options.maxBytes} bytes`),
          );
          socket.destroy();
          break;
        }
        await write(frameChunk(Buffer.from(chunk)));
      }
      await write(INSTREAM_TERMINATOR);
      return await responsePromise;
    } finally {
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
    }
  }

  async scan(source: Buffer | Uint8Array | Readable, input: ScanInput): Promise<ScanResult> {
    const started = Date.now();
    const done = (partial: Omit<ScanResult, 'engine' | 'durationMs'>): ScanResult => ({
      ...partial,
      engine: CLAMAV_ENGINE,
      durationMs: Date.now() - started,
    });
    if (input.sizeBytes > this.options.maxBytes) {
      return done({
        verdict: 'error',
        signature: null,
        error: `file (${input.sizeBytes} bytes) exceeds the scanner limit of ${this.options.maxBytes} bytes; object remains quarantined`,
      });
    }
    try {
      const raw = await this.instream(source);
      const parsed = parseClamResponse(raw);
      if (parsed.verdict === 'error')
        return done({ verdict: 'error', signature: null, error: parsed.error });
      return done({ verdict: parsed.verdict, signature: parsed.signature });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown scanner failure';
      return done({ verdict: 'error', signature: null, error: message.slice(0, 200) });
    }
  }
}
