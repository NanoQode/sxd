import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DevMalwareScanner, EICAR_TEST_STRING } from './dev';
import { createMalwareScanner, scannerConfigFromEnv } from './factory';

describe('DevMalwareScanner', () => {
  const scanner = new DevMalwareScanner({ appEnv: 'test' });

  it('flags the EICAR string and passes everything else', async () => {
    expect(EICAR_TEST_STRING.startsWith('X5O!P%@AP[4\\PZX54(P^)7CC)7}$')).toBe(true);
    expect(await scanner.scan(Buffer.from(EICAR_TEST_STRING), { fileName: 'eicar.com', sizeBytes: 68 })).toMatchObject({
      verdict: 'infected',
      signature: 'Eicar-Signature',
      engine: 'dev-eicar',
    });
    expect(await scanner.scan(Readable.from([Buffer.from('hello '), Buffer.from('world')]), { fileName: 'a.txt', sizeBytes: 11 })).toMatchObject({
      verdict: 'clean',
      signature: null,
    });
    expect(await scanner.scan(Buffer.from('anything'), { fileName: 'report.scan-error.pdf', sizeBytes: 8 })).toMatchObject({
      verdict: 'error',
    });
    expect(await scanner.ping()).toMatchObject({ ok: true });
  });

  it('is refused outside development/test and selected by the factory', () => {
    expect(() => new DevMalwareScanner({ appEnv: 'production' })).toThrow(/development adapter/);
    expect(createMalwareScanner({ appEnv: 'development', scanner: 'dev' }).id).toBe('dev');
    expect(createMalwareScanner(scannerConfigFromEnv({ APP_ENV: 'production', MALWARE_SCANNER: 'clamav', CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3310' })).id).toBe(
      'clamav',
    );
    expect(() => createMalwareScanner({ appEnv: 'production', scanner: 'dev' })).toThrow(/development adapter/);
  });
});
