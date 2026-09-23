import { fileTypeFromBuffer } from 'file-type';
import { mimeMismatch } from '@simplexd/domain/evidence';
import { isActiveContentType, normalizeContentType } from './disposition';

/**
 * Content sniffing after receipt. `file-type` recognises binary formats by
 * magic numbers; it deliberately does not detect text formats, so markup and
 * scripts are checked separately (an SVG/HTML file declared as image/png must
 * be rejected, not just relabelled).
 */

export interface DetectedType {
  mime: string;
  ext: string;
}

export async function detectMime(buffer: Uint8Array): Promise<DetectedType | null> {
  const result = await fileTypeFromBuffer(buffer);
  return result ? { mime: result.mime, ext: result.ext } : null;
}

export type ActiveContentKind = 'svg' | 'html' | 'xml' | 'script' | null;

const SNIFF_BYTES = 4096;

/** Looks at the first bytes for markup or script signatures a browser could execute. */
export function sniffActiveContent(buffer: Uint8Array): {
  active: boolean;
  kind: ActiveContentKind;
} {
  const head = Buffer.from(buffer.subarray(0, SNIFF_BYTES))
    .toString('latin1')
    .replace(/^﻿|^\xEF\xBB\xBF/, '')
    .replace(/^[\s\x00]+/, '')
    .toLowerCase();
  if (head.startsWith('#!')) return { active: true, kind: 'script' };
  if (/<svg[\s>]/.test(head)) return { active: true, kind: 'svg' };
  if (/^<!doctype html|<html[\s>]|<script[\s>]|<iframe[\s>]|<body[\s>]|<head[\s>]/.test(head))
    return { active: true, kind: 'html' };
  if (head.startsWith('<?xml')) {
    if (/<svg[\s>]|<html[\s>]|<xsl:|xmlns:xlink|<script/.test(head))
      return { active: true, kind: 'svg' };
    return { active: true, kind: 'xml' };
  }
  return { active: false, kind: null };
}

export interface MimeAgreement {
  agrees: boolean;
  /** Detected type when available, otherwise the declared one. */
  effectiveMime: string;
  reason?: string;
}

/** Uses the domain mime policy (family matches such as jpeg/jpg, heic/heif and Office-in-zip are fine). */
export function agreesWithDeclared(declared: string, detected: DetectedType | null): MimeAgreement {
  const declaredType = normalizeContentType(declared);
  if (!detected) return { agrees: true, effectiveMime: declaredType };
  if (mimeMismatch(declaredType, detected.mime)) {
    return {
      agrees: false,
      effectiveMime: detected.mime,
      reason: `declared ${declaredType} but content is ${detected.mime}`,
    };
  }
  return { agrees: true, effectiveMime: detected.mime };
}

export interface UploadInspection {
  detected: DetectedType | null;
  active: { active: boolean; kind: ActiveContentKind };
  agreement: MimeAgreement;
  effectiveMime: string;
  /** True when the file must be rejected regardless of the scanner verdict. */
  reject: boolean;
  reason: string | null;
}

/** Combined post-upload inspection of the first bytes of an object. */
export async function inspectUploadedBytes(
  buffer: Uint8Array,
  declaredMime: string,
): Promise<UploadInspection> {
  const detected = await detectMime(buffer);
  const active = sniffActiveContent(buffer);
  const agreement = agreesWithDeclared(declaredMime, detected);
  let reject = false;
  let reason: string | null = null;
  if (active.active) {
    reject = true;
    reason = `content looks like ${active.kind} markup/script, which is never accepted`;
  } else if (isActiveContentType(agreement.effectiveMime)) {
    reject = true;
    reason = `${agreement.effectiveMime} content is not accepted`;
  } else if (!agreement.agrees) {
    reject = true;
    reason = agreement.reason ?? 'declared type does not match content';
  }
  return { detected, active, agreement, effectiveMime: agreement.effectiveMime, reject, reason };
}
