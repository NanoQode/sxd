/**
 * Notification template rendering (brief §13/§14).
 *
 * Templates use `{{variable}}` placeholders (see `notificationTemplates` in
 * packages/db/src/seed/reference.ts). Substitution is strict: every
 * placeholder must be supplied or `renderTemplate` throws a
 * `TemplateRenderError` listing the missing names. Values are HTML-escaped
 * in the HTML body and inserted verbatim in the text body and subject.
 */

export interface TemplateSource {
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
}

export type TemplateVariables = Record<string, string | number>;

export interface RenderedTemplate {
  subject: string | null;
  text: string;
  /** Rendered `bodyHtml`, or null when the template has no HTML body. */
  html: string | null;
  variables: string[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export class TemplateRenderError extends Error {
  constructor(readonly missing: string[]) {
    super(`missing template variables: ${missing.join(', ')}`);
    this.name = 'TemplateRenderError';
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Unique placeholder names in a string, in order of first appearance. */
export function extractVariables(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function templateVariables(template: TemplateSource): string[] {
  const names: string[] = [];
  for (const part of [template.subject, template.bodyText, template.bodyHtml]) {
    for (const name of extractVariables(part)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

function substitute(
  text: string,
  variables: TemplateVariables,
  transform: (value: string) => string,
): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => transform(String(variables[name])));
}

export function renderTemplate(template: TemplateSource, variables: TemplateVariables): RenderedTemplate {
  const names = templateVariables(template);
  const missing = names.filter((name) => {
    const value = variables[name];
    return value === undefined || value === null;
  });
  if (missing.length > 0) throw new TemplateRenderError(missing);
  return {
    subject: template.subject ? substitute(template.subject, variables, (v) => v) : null,
    text: substitute(template.bodyText, variables, (v) => v),
    html: template.bodyHtml ? substitute(template.bodyHtml, variables, escapeHtml) : null,
    variables: names,
  };
}

const URL_IN_ESCAPED_TEXT = /(https?:\/\/[^\s<]+?)([.,;:!?)]*)(?=\s|$)/g;

/** Escapes text and turns paragraphs, line breaks and URLs into simple HTML. */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return paragraphs
    .map((paragraph) => {
      const escaped = escapeHtml(paragraph).replace(
        URL_IN_ESCAPED_TEXT,
        (_m, url: string, trailing: string) =>
          `<a href="${url}" style="color:#1f4d3f;">${url}</a>${trailing}`,
      );
      return `<p style="margin:0 0 16px;">${escaped.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

export interface HtmlLayoutInput {
  title: string;
  /** Trusted HTML (already rendered/escaped). */
  bodyHtml: string;
  brandName: string;
  appUrl: string;
  footerNote: string;
  /** Hidden preview text shown by inbox clients. */
  preheader?: string;
  lang?: string;
}

/**
 * Simple, responsive, accessible HTML email: single 600px column, inline
 * styles, light background, no external images or scripts, `lang` and a
 * real heading so screen readers announce the message correctly.
 */
export function wrapHtmlLayout(input: HtmlLayoutInput): string {
  const title = escapeHtml(input.title);
  const brand = escapeHtml(input.brandName);
  const appUrl = escapeHtml(input.appUrl);
  const footer = escapeHtml(input.footerNote);
  const lang = escapeHtml(input.lang ?? 'en');
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f2ec;color:#1f2a2e;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f2ec;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;">
<tr><td style="padding:24px 24px 8px;font-size:20px;font-weight:700;color:#1f4d3f;">${brand}</td></tr>
<tr><td style="padding:8px 24px 24px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1f2a2e;">${title}</h1>
${input.bodyHtml}
</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e6e1d8;font-size:13px;line-height:1.5;color:#5a6468;">
<p style="margin:0 0 8px;">${footer}</p>
<p style="margin:0;"><a href="${appUrl}" style="color:#1f4d3f;">${appUrl}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain-text fallback derived from HTML: links become `text (url)`, blocks become line breaks. */
export function textFromHtml(html: string): string {
  let text = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const label = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim();
      const url = decodeHtmlEntities(href).trim();
      return label && label !== url ? `${label} (${url})` : url;
    },
  );
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface TemplatePreview extends RenderedTemplate {
  /** Variables that had no sample value and were rendered as `[name]`. */
  missing: string[];
}

/** Renders a template for the admin preview; unknown variables become `[name]` instead of failing. */
export function previewTemplate(
  template: TemplateSource,
  sampleVariables: TemplateVariables = {},
): TemplatePreview {
  const names = templateVariables(template);
  const missing = names.filter((name) => sampleVariables[name] === undefined);
  const filled: TemplateVariables = { ...sampleVariables };
  for (const name of missing) filled[name] = `[${name}]`;
  return { ...renderTemplate(template, filled), missing };
}

export interface EmailLayoutOptions {
  brandName: string;
  appUrl: string;
  footerNote: string;
  preheader?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Full email from a template: subject + text body + branded HTML. Templates
 * without `bodyHtml` get HTML derived from the text body (paragraphs and links).
 */
export function renderEmail(
  template: TemplateSource,
  variables: TemplateVariables,
  layout: EmailLayoutOptions,
): RenderedEmail {
  const rendered = renderTemplate(template, variables);
  const subject = rendered.subject ?? layout.brandName;
  const bodyHtml = rendered.html ?? textToHtml(rendered.text);
  return {
    subject,
    text: rendered.text,
    html: wrapHtmlLayout({
      title: subject,
      bodyHtml,
      brandName: layout.brandName,
      appUrl: layout.appUrl,
      footerNote: layout.footerNote,
      preheader: layout.preheader,
    }),
  };
}
