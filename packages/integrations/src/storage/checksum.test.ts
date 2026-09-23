import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { normalizeSha256, sha256Hex, sha256HexSync, verifyDeclaredChecksum } from './checksum';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('checksums', () => {
  it('hashes buffers and streams identically', async () => {
    expect(sha256HexSync(Buffer.from('abc'))).toBe(ABC_SHA256);
    expect(await sha256Hex(Buffer.from('abc'))).toBe(ABC_SHA256);
    expect(await sha256Hex(Readable.from([Buffer.from('a'), Buffer.from('bc')]))).toBe(ABC_SHA256);
  });

  it('normalises hex and base64 declarations', () => {
    expect(normalizeSha256(ABC_SHA256.toUpperCase())).toBe(ABC_SHA256);
    expect(normalizeSha256(`sha256:${ABC_SHA256}`)).toBe(ABC_SHA256);
    expect(normalizeSha256(Buffer.from(ABC_SHA256, 'hex').toString('base64'))).toBe(ABC_SHA256);
    expect(normalizeSha256('nope')).toBeNull();
  });

  it('verifies declared checksums', () => {
    expect(verifyDeclaredChecksum(ABC_SHA256, ABC_SHA256)).toEqual({
      ok: true,
      sha256: ABC_SHA256,
    });
    expect(verifyDeclaredChecksum(null, ABC_SHA256)).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(verifyDeclaredChecksum('zzz', ABC_SHA256)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyDeclaredChecksum(sha256HexSync(Buffer.from('abd')), ABC_SHA256)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
  });
});
