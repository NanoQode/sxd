import { describe, expect, it } from 'vitest';
import {
  contentDispositionHeader,
  isActiveContentType,
  isInlineSafe,
  resolveContentDisposition,
  safeFileName,
} from './disposition';

describe('content disposition policy', () => {
  it('never serves markup or scripts inline, even when requested', () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'application/xml', 'text/xml']) {
      expect(resolveContentDisposition(type, 'inline'), type).toEqual({
        disposition: 'attachment',
        contentType: 'application/octet-stream',
      });
      expect(isActiveContentType(type)).toBe(true);
      expect(isInlineSafe(type)).toBe(false);
    }
    expect(resolveContentDisposition('image/svg+xml; charset=utf-8', 'attachment').contentType).toBe('application/octet-stream');
  });

  it('allows inline only for images, video and PDF', () => {
    expect(resolveContentDisposition('image/png', 'inline')).toEqual({ disposition: 'inline', contentType: 'image/png' });
    expect(resolveContentDisposition('video/mp4', 'inline')).toEqual({ disposition: 'inline', contentType: 'video/mp4' });
    expect(resolveContentDisposition('application/pdf', 'inline')).toEqual({ disposition: 'inline', contentType: 'application/pdf' });
    expect(resolveContentDisposition('image/JPEG; charset=binary', 'inline')).toEqual({ disposition: 'inline', contentType: 'image/jpeg' });
    expect(
      resolveContentDisposition('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'inline'),
    ).toEqual({
      disposition: 'attachment',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(resolveContentDisposition('application/pdf', 'attachment').disposition).toBe('attachment');
    expect(resolveContentDisposition('', 'inline')).toEqual({ disposition: 'attachment', contentType: 'application/octet-stream' });
  });

  it('builds a safe Content-Disposition header', () => {
    expect(contentDispositionHeader('attachment', 'report.pdf')).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
    expect(contentDispositionHeader('inline', 'plan "final"\r\nX: y ünïcode.png')).toBe(
      "inline; filename=\"plan finalX: y _n_code.png\"; filename*=UTF-8''plan%20finalX%3A%20y%20%C3%BCn%C3%AFcode.png",
    );
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('   ')).toBe('download');
  });
});
