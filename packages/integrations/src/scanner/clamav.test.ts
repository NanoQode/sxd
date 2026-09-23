import net from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, frameChunk, parseClamResponse } from './clamav';
import { EICAR_TEST_STRING } from './dev';

interface FakeClamd {
  port: number;
  frameLengths: number[];
  received: Buffer[];
  commands: string[];
  close(): Promise<void>;
}

/** Minimal clamd that understands z-mode PING/VERSION/INSTREAM and verifies the length-prefixed framing. */
async function startFakeClamd(behaviour: { respond?: (data: Buffer) => string | null } = {}): Promise<FakeClamd> {
  const sockets = new Set<net.Socket>();
  const frameLengths: number[] = [];
  const received: Buffer[] = [];
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let streaming = false;
    const parts: Buffer[] = [];
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!streaming) {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        const command = buffer.subarray(0, nul).toString();
        commands.push(command);
        buffer = buffer.subarray(nul + 1);
        if (command === 'zPING') return void socket.end('PONG\0');
        if (command === 'zVERSION') return void socket.end('ClamAV 1.4.1/27400/Tue Sep 22 2026\0');
        if (command !== 'zINSTREAM') return void socket.end('UNKNOWN COMMAND\0');
        streaming = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          buffer = buffer.subarray(4);
          const data = Buffer.concat(parts);
          received.push(data);
          const reply = behaviour.respond
            ? behaviour.respond(data)
            : data.toString('latin1').includes(EICAR_TEST_STRING)
              ? 'stream: Eicar-Test-Signature FOUND\0'
              : 'stream: OK\0';
          if (reply !== null) socket.end(reply);
          return;
        }
        if (buffer.length < 4 + length) break;
        parts.push(Buffer.from(buffer.subarray(4, 4 + length)));
        frameLengths.push(length);
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    frameLengths,
    received,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const servers: FakeClamd[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('ClamAvScanner', () => {
  it('frames INSTREAM chunks with big-endian lengths and a zero terminator', async () => {
    const server = await startFakeClamd();
    servers.push(server);
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: server.port, chunkBytes: 64 * 1024, timeoutMs: 5000 });
    const payload = Buffer.alloc(200 * 1024 + 17, 7);
    const result = await scanner.scan(payload, { fileName: 'big.bin', sizeBytes: payload.length });
    expect(result).toMatchObject({ verdict: 'clean', signature: null, engine: 'clamav' });
    expect(server.commands).toEqual(['zINSTREAM']);
    expect(server.frameLengths).toEqual([65536, 65536, 65536, 17 + 3 * 65536 - 3 * 65536]);
    expect(Buffer.concat(server.received).equals(payload)).toBe(true);
    expect(frameChunk(Buffer.from('ab'))).toEqual(Buffer.from([0, 0, 0, 2, 0x61, 0x62]));
  });

  it('parses FOUND responses from streamed input', async () => {
    const server = await startFakeClamd();
    servers.push(server);
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: server.port, chunkBytes: 8 });
    const stream = Readable.from([Buffer.from('prefix '), Buffer.from(EICAR_TEST_STRING), Buffer.from(' suffix')]);
    const result = await scanner.scan(stream, { fileName: 'eicar.com', sizeBytes: 100 });
    expect(result).toMatchObject({ verdict: 'infected', signature: 'Eicar-Test-Signature' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('answers PING/VERSION', async () => {
    const server = await startFakeClamd();
    servers.push(server);
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: server.port });
    expect(await scanner.ping()).toEqual({ ok: true, version: 'ClamAV 1.4.1/27400/Tue Sep 22 2026' });
    expect(server.commands).toEqual(['zPING', 'zVERSION']);
  });

  it('returns an error verdict (object stays quarantined) on timeout, refusal and size limits', async () => {
    const silent = await startFakeClamd({ respond: () => null });
    servers.push(silent);
    const slow = new ClamAvScanner({ host: '127.0.0.1', port: silent.port, timeoutMs: 150 });
    const timeout = await slow.scan(Buffer.from('hello'), { fileName: 'a.txt', sizeBytes: 5 });
    expect(timeout.verdict).toBe('error');
    expect(timeout.error).toMatch(/timeout/);

    const closed = await startFakeClamd();
    const { port } = closed;
    await closed.close();
    const refused = await new ClamAvScanner({ host: '127.0.0.1', port, connectTimeoutMs: 500 }).scan(Buffer.from('x'), {
      fileName: 'a.txt',
      sizeBytes: 1,
    });
    expect(refused.verdict).toBe('error');
    expect(refused.error).toMatch(/ECONNREFUSED/);

    const limited = new ClamAvScanner({ host: '127.0.0.1', port, maxBytes: 10 });
    const tooBig = await limited.scan(Buffer.alloc(11), { fileName: 'big.bin', sizeBytes: 11 });
    expect(tooBig).toMatchObject({ verdict: 'error', error: expect.stringContaining('quarantined') });
    expect((await new ClamAvScanner({ host: '127.0.0.1', port }).ping()).ok).toBe(false);
  });

  it('parses clamd response lines', () => {
    expect(parseClamResponse('stream: OK\0')).toEqual({ verdict: 'clean', signature: null });
    expect(parseClamResponse('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({ verdict: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
    expect(parseClamResponse('INSTREAM size limit exceeded. ERROR')).toMatchObject({ verdict: 'error', error: expect.stringContaining('size limit') });
    expect(parseClamResponse('???')).toMatchObject({ verdict: 'error' });
    expect(() => new ClamAvScanner({ host: '', port: 3310 })).toThrow(/CLAMAV_HOST/);
  });
});
