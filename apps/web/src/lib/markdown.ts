import 'server-only';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * Markdown to sanitized HTML for CMS content, profiles and reports. Scripts,
 * inline event handlers, iframes and unknown protocols are stripped so a
 * content editor cannot inject executable markup.
 */

const allowedTags = [
  'h2',
  'h3',
  'h4',
  'p',
  'br',
  'strong',
  'em',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'code',
  'pre',
  'hr',
  'figure',
  'figcaption',
  'span',
  'sup',
  'sub',
];

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      td: ['align'],
      th: ['align'],
      span: ['class'],
      code: ['class'],
    },
    allowedSchemes: ['https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
    },
  });
}

export function plainTextExcerpt(markdown: string, maxLength = 160): string {
  const text = markdown
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
