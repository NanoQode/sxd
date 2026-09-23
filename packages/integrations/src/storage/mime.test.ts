import { describe, expect, it } from 'vitest';
import { agreesWithDeclared, detectMime, inspectUploadedBytes, sniffActiveContent } from './mime';

const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000000', 'hex');
const PDF = Buffer.from(
  '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n',
  'latin1',
);
const SVG = Buffer.from(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = Buffer.from('﻿  <!DOCTYPE html><html><body>hi</body></html>');

describe('mime detection', () => {
  it('detects PNG and PDF by magic numbers', async () => {
    expect(await detectMime(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(await detectMime(PDF)).toEqual({ mime: 'application/pdf', ext: 'pdf' });
    expect(await detectMime(Buffer.from('plain text'))).toBeNull();
  });

  it('sniffs markup and scripts that file-type does not classify', () => {
    expect(sniffActiveContent(SVG)).toEqual({ active: true, kind: 'svg' });
    expect(sniffActiveContent(HTML)).toEqual({ active: true, kind: 'html' });
    expect(sniffActiveContent(Buffer.from('#!/bin/sh\nrm -rf /'))).toEqual({
      active: true,
      kind: 'script',
    });
    expect(sniffActiveContent(PNG)).toEqual({ active: false, kind: null });
    expect(sniffActiveContent(Buffer.from('name,value\n1,2\n'))).toEqual({
      active: false,
      kind: null,
    });
  });

  it('applies the domain mime-mismatch rules', () => {
    expect(agreesWithDeclared('image/jpg', { mime: 'image/jpeg', ext: 'jpg' })).toMatchObject({
      agrees: true,
      effectiveMime: 'image/jpeg',
    });
    expect(
      agreesWithDeclared(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        { mime: 'application/zip', ext: 'zip' },
      ).agrees,
    ).toBe(true);
    expect(agreesWithDeclared('image/png', { mime: 'application/pdf', ext: 'pdf' })).toMatchObject({
      agrees: false,
    });
    expect(agreesWithDeclared('text/csv', null)).toMatchObject({
      agrees: true,
      effectiveMime: 'text/csv',
    });
  });

  it('rejects disguised markup and mismatched content, accepts honest uploads', async () => {
    const svgAsPng = await inspectUploadedBytes(SVG, 'image/png');
    expect(svgAsPng.reject).toBe(true);
    expect(svgAsPng.reason).toMatch(/svg/);
    const pdfAsPng = await inspectUploadedBytes(PDF, 'image/png');
    expect(pdfAsPng.reject).toBe(true);
    expect(pdfAsPng.effectiveMime).toBe('application/pdf');
    const honest = await inspectUploadedBytes(PNG, 'image/png');
    expect(honest).toMatchObject({ reject: false, reason: null, effectiveMime: 'image/png' });
    const declaredHtml = await inspectUploadedBytes(Buffer.from('just text'), 'text/html');
    expect(declaredHtml.reject).toBe(true);
  });
});
