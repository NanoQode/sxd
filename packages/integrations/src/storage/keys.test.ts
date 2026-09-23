import { describe, expect, it } from 'vitest';
import { buildStorageKey, deriveVariantKey, isValidStorageKey, normalizeExtension } from './keys';

describe('storage keys', () => {
  it('accepts only the narrow safe character set', () => {
    expect(isValidStorageKey('org/acme/evidence/0b6f3c1a-1111-4222-8333-444455556666.jpg')).toBe(true);
    expect(isValidStorageKey('shared/cms-media/abc12345.png')).toBe(true);
    for (const bad of [
      '',
      '/leading/slash.jpg',
      'trailing/slash/',
      'double//slash.jpg',
      'org/../etc/passwd',
      'Org/Upper.jpg',
      'space in/key.jpg',
      'org/.hidden/file.jpg',
      'unicode/ünïcode.jpg',
      `${'a'.repeat(901)}`,
    ]) {
      expect(isValidStorageKey(bad), bad).toBe(false);
    }
  });

  it('builds organisation-scoped keys and refuses blocked extensions', () => {
    expect(
      buildStorageKey({ organizationId: 'Org_ABC', purpose: 'Site Photos', fileId: '0B6F3C1A-1111-4222-8333-444455556666', ext: 'JPG' }),
    ).toBe('org/org-abc/site-photos/0b6f3c1a-1111-4222-8333-444455556666.jpg');
    expect(buildStorageKey({ organizationId: null, purpose: 'cms-media', fileId: 'abcdef12-3456', ext: null })).toBe(
      'shared/cms-media/abcdef12-3456',
    );
    expect(() => buildStorageKey({ organizationId: 'o', purpose: 'p', fileId: 'abcdef12-3456', ext: '.svg' })).toThrow(/not accepted/);
    expect(() => buildStorageKey({ organizationId: 'o', purpose: 'p', fileId: 'abcdef12-3456', ext: '.html' })).toThrow(/not accepted/);
    expect(() => buildStorageKey({ organizationId: 'o', purpose: 'p', fileId: '../x', ext: '.jpg' })).toThrow(/fileId/);
    expect(normalizeExtension('webp')).toBe('.webp');
    expect(() => normalizeExtension('.tar.gz')).toThrow(/invalid extension/);
  });

  it('derives variant keys next to the original', () => {
    expect(deriveVariantKey('org/o/evidence/abc.jpg', 'thumb', 'webp')).toBe('org/o/evidence/abc.thumb.webp');
    expect(deriveVariantKey('shared/doc/abc', 'Redacted Copy', '.pdf')).toBe('shared/doc/abc.redacted-copy.pdf');
    expect(() => deriveVariantKey('bad key', 'thumb', 'webp')).toThrow(/invalid storage key/);
  });
});
